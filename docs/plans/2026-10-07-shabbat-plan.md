# Shabbat and Yom Tov mode: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No work on Shabbat or the Israel Yom Tov days: the weekly pace line counts working time only; every lane is
paused from one hour before sunset and closed from sunset (by force after a 10-minute grace); nothing resumes until
the user asks after nightfall; the watcher is quiet meanwhile; one global switch (`shabbos on|off`), on by default.

**Architecture:** The calendar is data: `claude/skills/handoff-launch/offtimes.json`, generated once by a dev-only tool
(`tools/gen-offtimes.mjs`) and committed. Pure decisions go in `pace-lib.mjs` (table checks, merged working time) and
`pause-lib.mjs` (the `shabbat` source, the tick's line, the force rule, the resume rule). `pause-io.mjs` owns the
files (`shabbos.json`, `pause/resume-request.json`, the table path). `recover.mjs` (the tick) marks and closes at
sunset; `hooks/coord.mjs` gets `shabbos`, the resume request and the watcher's quiet branch.

**Tech Stack:** Node >= 18 ESM, `node:test`. No new runtime dependency. `@hebcal/core` is used only by the dev
generator, from a directory outside the repo (S1b, a host step).

**Spec:** `docs/plans/2026-10-07-shabbat-followup.md` (requirements 1-7, interfaces, tasks S0-S6; user-approved
2026-10-07). Read it with this plan. The batch B plan (`docs/plans/2026-10-06-batchB-pause-pacing.md`) explains the
pause protocol this extends.

Run every check from the repo root. Full suite: `timeout 2400 node --test "claude/skills/handoff-launch/tests/*.test.mjs"`.

## Global Constraints

- **Fail open on the table:** a missing, unreadable, invalid (unsorted, overlapping, `start >= end`, wrong `tz`) or
  expired (`now >= until`) `offtimes.json` means no off-time: no `shabbat` source, plain 7-day pacing, no quiet watcher.
  While Shabbat mode is on, a missing or invalid table raises ONE alert per day from the tick (user ruling 2), and a
  valid table with under 60 days left raises one alert per table.
- **Fail SAFE ON for the switch:** `<coord>/shabbos.json` missing, unreadable, not an object, or `enabled` not exactly
  `false` means enabled. Every reader goes through `shabbosEnabled()` (in `offtimes-io.mjs`, re-exported by `pause-io.mjs`).
- **Epoch ms everywhere** for the new data: table `start`, `end`, `until`, `generated`; `shabbos.json changed_at`;
  `resume-request.json at`; the `{paused}` line's `end`. (Existing ISO fields such as `at` and a source's `since` stay ISO.)
- **No new runtime dependency.** `@hebcal/core` is dev-only, never in the repo, never imported by hooks or the tick.
- **Lean hot path:** the switch and table readers live in `offtimes-io.mjs`, which imports only `live.mjs` and the pure
  `pace-lib.mjs` (itself import-free). `pace-io.mjs` (the status line's module) imports it, never `pause-io.mjs`.
- **Atomic writes:** every new file write is `writeAtomic` (tmp + rename), wrapped in pause-io's `retried` where
  pause-io already does so for its siblings.
- **Tests never use the real calendar or the real coord dir:** pure tests inject `now` and tables; integration tests use
  `tests/helpers.mjs sandbox()` (its own `CLAUDE_CONFIG_DIR`). The sandbox writes an EMPTY VALID table at `sb.offtimes`
  (`{tz: "Asia/Jerusalem", until: Date.UTC(2100, 0, 1), intervals: []}`) and points `HL_OFFTIMES_FILE` at it (S0): no
  existing test sees the committed table or the missing-table alert. A test that needs off-time rewrites `sb.offtimes`
  with intervals relative to its `Date.now()`; a test of the missing-table alert deletes it.
- **Constants, not config keys:** lead `SHABBAT_LEAD_MIN = 60`, grace `SHABBAT_GRACE_MIN = 10`, watcher look-ahead
  `SHABBAT_WATCH_AHEAD_MIN = 120`, expiry alert below 60 days, missing-table alert every 24 h. Large-org variant:
  per-site calendars and config keys; not needed for one machine.
- **Liveness `unknown` is never acted on** (unchanged batch B rule); the force close goes through `live.mjs killTree`,
  which re-probes and kills only a verified `running` session.
- **Public repo:** no personal paths, emails, account names; write `<config>` for the config dir.
- Commit only the files the task names, by name. Never `git add -A`.

## Rulings in this plan (user rulings of 2026-10-07, and contradictions found)

1. **License (user ruling: option A).** The spec says `@hebcal/core` is MIT; the npm registry (checked 2026-10-07) says
   `@hebcal/core` 6.14.0 is **GPL-2.0** (deps: `@hebcal/hdate` GPL-2.0, `@hebcal/noaa` LGPL-2.1). The user chose A: a
   dev-only tool, installed outside the repo, imported by path, never committed or shipped; the committed JSON holds
   dates and times and records the version (`source`) and the license (`license`). S1b is unblocked.
2. **Missing or invalid table (user ruling).** While the mode is on, the tick raises one alert per day (S2). Fail open
   otherwise (no off-time).
3. **Nightfall raises nothing (user ruling).** No alert at nightfall: rows stay quiet until the user's resume; the
   manifest's hand-opened "pause ended" alert is not raised for a pause that spanned an off interval; at the user's
   resume the printed `claude --resume` lines are the channel (S5 M6, S6 M2).
4. **Grace and force (user ruling, req 3 open point).** At sunset a busy lane gets the tick's own `{paused}` line
   (source `shabbat`, `by: "tick"`), the guarded close, and a force close once `now >= start + 10 min`. A lane first
   seen past the grace (machine asleep at sunset) is closed through the force path even when idle: expected.
5. **The 5-hour line keeps plain minutes** (req 2). Today `providerState` passes `off` to both windows
   (`pace-lib.mjs:115`); S2 passes it to the weekly window only.
6. **Text after sunset** (spec gives only the lead-hour text): `Shabbat/Yom Tov has begun: save state and end your turn
   now. Work resumes when the user asks (/broadcast resume).` The lane Stop's save prompt uses the source's text too.
7. **The user-wait rule is a property of timing (review I1).** Any pending row, whatever its source, whose pause began
   before an off interval's end with that end now past (or whose `shabbat` line names an `end`) waits for a resume
   request `{at, enabled}` with `at > pausedAt` and (`at >=` that end, or `enabled === false`). So a manual pause that
   expired on Shabbat does not relaunch at nightfall. A request made during the lead hour or the interval never counts;
   one made with the switch off does.
8. **Spec test placement:** the spec puts "off: no shabbat source and plain 7-day pacing" under S0, but the source and
   the working-time line do not exist until S2/S3. The switch helper ships in S0; that test lives in S3.
9. **Watcher vs close (contradiction).** Req 5 says the watcher does not tick in off-time; req 3 needs ticks after
   sunset to close lanes and force-close after the grace. Ruling: in an off interval the watcher runs a tick only while
   an open, not-yet-alerted lane is left (to close it), with no 5-minute back-off; otherwise nothing (no tick, no pace,
   no power). The tick itself skips `powerTick`/`paceTick` inside an off interval. The tick starts the watcher when an
   off interval begins within 120 min and a lane is open, and the watcher does not stop meanwhile (review M2).
10. **By-hand relaunch** (`launch.mjs resume --paused`) is unchanged: it is the user's explicit act. It still refuses
   while the `shabbat` source applies (`pauseForNow`).
11. **Carry (pause-lib.mjs:95)** reproduces by reading (see C1). It only delays a resume by up to 5 min after the
   launch; it is still fixed, red test first.

## Review Focus

1. **The host clock is not in Israel, or DST changes inside an interval** (late-October DST end on a Saturday night).
   Expected: nothing changes: all logic compares epoch ms. Pinned by S1b's local-hour checks (Intl, `Asia/Jerusalem`)
   and S3's pure tests with ms inputs.
2. **The switch is turned off in the middle of Shabbat, then `/broadcast resume`.** Expected: the source goes at once;
   the closed lanes relaunch on that resume (ruling 7). Test in S5 ("resume after shabbos off relaunches at once").
3. **`/broadcast resume` before nightfall** (the user returns early). Expected: the request is recorded but does not
   count; `resume` says so and the rows wait. Test in S5 ("a request during the interval does not count").
4. **A lane that cannot be killed** (bg lane without `bg_id`, liveness unknown, a pending ladder, kill fails). Expected:
   skipped, counted, one alert at the second tick; the quiet watcher stops ticking for it once alerted. Test in S4 ("a
   bg lane without a bg_id is counted and alerted, never killed").
5. **The installed table is missing** (an install that skipped the file). Expected: no off-time, and one alert a day
   while the mode is on. Test in S2 ("a missing table alerts once a day").

## File structure

| File | Change | Task |
|---|---|---|
| `claude/skills/handoff-launch/offtimes-io.mjs` | create: `SHABBOS`, `shabbosEnabled`, `OFFTIMES_FILE` (S0); `readOffTimes`, `offTimesStatus` (S2) | S0, S2 |
| `claude/skills/handoff-launch/pause-lib.mjs` | `pausedLanes` fix; `shabbatSource`, constants, texts, `shabbatLine`, `shabbatLineDue`, `shabbatForceDue`, `userWaitEnd`, `awaitsUser`; `activeSources({off})`, `pauseFor` pass-through, `resumePlan({off, resumeReq})`, `laneRow` source | C1, S3, S4, S5 |
| `claude/skills/handoff-launch/pause-io.mjs` | re-export the switch; `writeShabbos`; re-export table readers; `readSources` off; resume request; `watchNeeded` look-ahead | S0, S2, S3, S5 |
| `claude/skills/handoff-launch/pace-lib.mjs` | `workingMinutes` merge; `offStatus`, `offIntervals`, alert texts; 5-hour plain; `gateDecision` text | S2, S3 |
| `claude/skills/handoff-launch/pace-io.mjs` | re-export `readOffTimes`/`offTimesStatus` from `offtimes-io.mjs`; `recomputePace` off | S2 |
| `claude/skills/handoff-launch/recover.mjs` | table alerts; off-time skips pace/power; sunset mark + force close; user-wait rule in resume, watcher start and manifest | S2, S4, S5 |
| `claude/hooks/coord.mjs` | `shabbos`; pre-filter `offNear`; Stop text; `{paused}` `end`; resume request; watcher quiet + look-ahead | S0, S3, S5 |
| `claude/skills/handoff-launch/tests/helpers.mjs` | sandbox empty valid table, `HL_OFFTIMES_FILE`, `sb.offtimes` | S0 |
| `tools/offtimes-lib.mjs`, `tools/gen-offtimes.mjs` | create (dev only) | S1a |
| `claude/skills/handoff-launch/offtimes.json` | create (generated) | S1b |
| `claude/skills/broadcast/SKILL.md`, `handoff-launch/coordinator.md`, `handoff-launch/SKILL.md` | docs | S6 |

## Order, dependencies, parallelism

| Task | Builds on | Parallel with (disjoint files) | Writer |
|---|---|---|---|
| C1 `pausedLanes` {starting} carry | main | S0, S1a | Codex or sonnet |
| S0 the switch, `offtimes-io.mjs`, sandbox table | main | C1, S1a | Codex or sonnet |
| S1a generator lib + CLI (fake calendar) | main | C1, S0 | Codex or sonnet |
| S1b host: install (option A), generate, commit table + table test | S1a | S2 | controller or sonnet (network) |
| S2 working-time weekly line, table alerts | S0 | S1b | Codex or sonnet |
| S3 the `shabbat` source and gate text | S2, C1 | - | Codex or sonnet |
| S4 close at sunset, grace, force | S3 | - | Codex or sonnet |
| S5 no automatic resume, watcher quiet and look-ahead, manifest | S4 | - | Codex or sonnet |
| S6 docs, broadcast phrases, release checkpoint | S5, S1b | - | sonnet; checkpoint by controller |

Each task: one opus review; S4 and S5 are the correctness-critical ones (closing and relaunching sessions).

---

### Task C1: `pausedLanes` counts only a `{starting}` line after the entry's launch line (carry)

**Goal:** a lane's OWN `{starting}` line never counts as "a launch in flight".

**Finding (verified by reading):** `launch.mjs:1039` stamps `launched_at` before the launcher appends its `{starting}`
line (`launch.mjs:1067`, `:1106`, and `:770` for a resume), and the launch line is appended after that. So the lane's
own `{starting}` line has `at > launched_at`, and `pause-lib.mjs:95` (`Date.parse(o.at) > t && now - Date.parse(o.at) <
5 * MIN`) counts it: a lane paused and closed within 5 min of its launch stays out of the resume list until its own
`{starting}` line is 5 min old. Effect: a delay of up to 5 min, never a lost lane. The registry-order rule to copy is
`recover-lib.mjs:359-366` (`launchTimeoutPending`: "Registry order decides later").

**Files:** Modify `claude/skills/handoff-launch/pause-lib.mjs:94-95`. Test: `claude/skills/handoff-launch/tests/pause-lib.test.mjs`.

**Read first:** `pause-lib.mjs:73-99`; `tests/pause-lib.test.mjs:69-81` (its lines hold no launch lines: the fallback must
keep it green); `live.mjs:58-73` (`readRegistry` keeps every line in `lines`, launch lines included).

**MUST**
- M1: a lane whose only `{starting}` line precedes its launch line in `lines` is pending once paused and closed, at any
  age. Test: `"C1 pausedLanes: the lane's own {starting} line (before its launch line) is no launch in flight"`.
- M2: a `{starting}` line after the entry's launch line, under 5 min old, still leaves the lane out; at 5 min or more it
  does not. Same test.
- M3: when the entry's launch line is not in `lines`, the old timestamp rule applies (existing test at `:77-80` passes).

- [ ] **Step 1: Write the failing test** (append to `tests/pause-lib.test.mjs`)

```js
test("C1 pausedLanes: the lane's own {starting} line (before its launch line) is no launch in flight", () => {
  const e = { id: "A@1", name: "A", repo: "r", group: "g", generation: 1, launched_at: iso(NOW - 4 * MIN), mode: "window" };
  const own = { starting: "A-s1", name: "A", group: "g", pid_file: null, at: iso(NOW - 4 * MIN + 500) };
  const base = [own, e, { paused: "A@1", source: "manual", at: iso(NOW - 3 * MIN) }, { closed: "A", id: "A@1", pause: true, at: iso(NOW - 2 * MIN) }];
  const run = (lines) => Q.pausedLanes({ entries: [e], lines, closed: new Set(["A@1"]), now: NOW }).map((p) => p.e.id);
  assert.deepEqual(run(base), ["A@1"]);
  assert.deepEqual(run([...base, { starting: null, name: "A", group: "g", pid_file: null, at: iso(NOW - MIN) }]), []); // a relaunch in flight
  assert.deepEqual(run([...base, { starting: null, name: "A", group: "g", pid_file: null, at: iso(NOW - 5 * MIN - 1) }]), ["A@1"]);
});
```

- [ ] **Step 2: Run, expect FAIL** (first assertion: `[]` instead of `["A@1"]`):
  `timeout 300 node --test "claude/skills/handoff-launch/tests/pause-lib.test.mjs"`

- [ ] **Step 3: Implement** (replace `pause-lib.mjs:94-95`; update the comment at `:76-79` to say "after its launch line")

```js
    const t = Date.parse(e.launched_at) || 0, i = (lines || []).findIndex((o) => o && o.id === e.id && o.launched_at);
    // registry order (recover-lib launchTimeoutPending's rule): the launcher writes its own {starting} line before its
    // launch line, so only one after it is another launch; without the launch line in `lines`, the timestamps decide
    if ((lines || []).some((o, n) => o && "starting" in o && o.name === e.name && (o.group ?? null) === (e.group ?? null)
      && (i >= 0 ? n > i : Date.parse(o.at) > t) && now - Date.parse(o.at) < 5 * MIN)) continue;
```

- [ ] **Step 4: Run the file, then the full suite; expect PASS.**
- [ ] **Step 5: Commit** `pause-lib.mjs`, `tests/pause-lib.test.mjs`: `fix(pause): a lane's own {starting} line is no launch in flight`

---

### Task S0: the switch (`offtimes-io.mjs`, `shabbosEnabled`, `coord.mjs shabbos on|off|status`), the sandbox table

**Goal:** one global switch, fail safe on, with its one CLI writer, in a small module the status line can afford; the
test sandbox gets an empty valid table so no test sees the committed one.

**Files:** Create `claude/skills/handoff-launch/offtimes-io.mjs`, `claude/skills/handoff-launch/tests/shabbos.test.mjs`.
Modify `claude/skills/handoff-launch/pause-io.mjs` (imports `:13-16`, after `writeUsagePause` `:66-72`);
`claude/hooks/coord.mjs` (header `:1-22`, after `usagePauseCmd` `:285-294`, `main` `:626-631`, error branch `:641`);
`claude/skills/handoff-launch/tests/helpers.mjs` (`:32` delete list, `:37-46` env, `:47-59` setup, `:70` returned object).

**Read first:** `pause-io.mjs:42-72` (`retried`, `writeManual`, `writeUsagePause`); `live.mjs:21-34` (`HERE`, `COORD`,
`readJson`); `coord.mjs:284-294` (`usagePauseCmd`: the `by` rule and the result shape); `tests/pause.test.mjs:12-15`
(the `ask` child pattern: these modules read `CLAUDE_CONFIG_DIR` at import).

**Interfaces produced:** `offtimes-io.mjs` (imports only `node:fs`, `node:path`, `./live.mjs`): `SHABBOS` (path),
`shabbosEnabled() -> bool`, `OFFTIMES_FILE` (path). `pause-io.mjs` re-exports `SHABBOS`, `shabbosEnabled`,
`OFFTIMES_FILE` and adds `writeShabbos({enabled, by}, now?) -> path`. `coord.mjs shabbosCmd(args, env) -> {code, text}`.
Sandbox: `sb.offtimes` (an existing empty valid table) and env `HL_OFFTIMES_FILE = sb.offtimes`.

**MUST**
- M1: `shabbosEnabled()` is true for a missing file, invalid JSON, `[]`, `{}`, `{enabled: "false"}`, `{enabled: 0}`;
  false only for an object with `enabled === false`. Tests: `"shabbos: a missing file is on"`, `"a malformed file is on"`.
- M2: `node coord.mjs shabbos off` writes `{enabled: false, changed_at: <ms>, by_session}` atomically (no `*.tmp` left),
  prints `shabbos: off (plain 7-day pacing, no Shabbat/Yom Tov pause)`, exit 0; `status` (or no argument) prints the
  state and writes nothing; `on` prints `shabbos: on (Shabbat/Yom Tov pause and working-time weekly pacing)`. A toggle
  rewrites, never deletes. Any other argument: exit 2, `usage: shabbos [on|off|status]`. `by_session` follows
  `usagePauseCmd`'s rule (`HL_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`, else `"user"`). Test: `"coord.mjs shabbos off,
  status, on: the round trip"`.
- M3: the sandbox deletes an inherited `HL_OFFTIMES_FILE`, writes `<tmp>/offtimes.json` =
  `{tz: "Asia/Jerusalem", until: Date.UTC(2100, 0, 1), intervals: []}`, sets `HL_OFFTIMES_FILE` to it and returns it as
  `sb.offtimes`. Test: in the round-trip test, `assert.deepEqual(JSON.parse(fs.readFileSync(sb.offtimes, "utf8")).intervals, [])`
  and `ask(sb, "PI.OFFTIMES_FILE") === sb.offtimes`.
- M4: `offtimes-io.mjs` imports no handoff-launch module other than `live.mjs` (S2 adds the pure `pace-lib.mjs`).
  Test: `"offtimes-io imports only live.mjs"` (read the file; every `from "./..."` is `./live.mjs` or `./pace-lib.mjs`).

- [ ] **Step 1: Write the failing tests** in `tests/shabbos.test.mjs` (header comment: "Shabbat mode, S0: the switch").
  Use `sandbox`, `coordRun` and the `ask` pattern from `tests/pause.test.mjs:12-15` (importing `pause-io.mjs`):

```js
test("shabbos: a missing file is on", () => { const sb = sandbox(); try { assert.equal(ask(sb, "PI.shabbosEnabled()"), true); } finally { sb.cleanup(); } });
test("a malformed file is on", () => {
  const sb = sandbox();
  try {
    const f = path.join(sb.coord, "shabbos.json");
    fs.mkdirSync(sb.coord, { recursive: true });
    for (const t of ["not json", "[]", "{}", '{"enabled":"false"}', '{"enabled":0}']) { fs.writeFileSync(f, t); assert.equal(ask(sb, "PI.shabbosEnabled()"), true, t); }
    fs.writeFileSync(f, '{"enabled":false}'); assert.equal(ask(sb, "PI.shabbosEnabled()"), false);
  } finally { sb.cleanup(); }
});
```
  The round trip: `coordRun(sb, ["shabbos", "off"], { env: { HL_SESSION_ID: "M@1" } })` -> exit 0, the exact line, the
  file `{enabled: false, by_session: "M@1"}` with `Math.abs(changed_at - Date.now()) < 60000`; no `*.tmp` in `sb.coord`;
  `status` -> the off line, file unchanged (`changed_at` equal); `on` -> the on line, `enabled: true`; `["shabbos",
  "maybe"]` -> exit 2 and the usage line.

- [ ] **Step 2: Run, expect FAIL:** `timeout 600 node --test "claude/skills/handoff-launch/tests/shabbos.test.mjs"`

- [ ] **Step 3: Implement.** `offtimes-io.mjs`:

```js
// Shabbat mode on disk (S0; S2 adds the table readers). Kept small for the status line's hot path: it imports only
// live.mjs (and, from S2, the pure pace-lib.mjs). Files:
//   <coord>/shabbos.json  {enabled, changed_at, by_session}  coord.mjs shabbos writes it; missing or malformed = on
//   <skill>/offtimes.json  the generated table (HL_OFFTIMES_FILE: tests)
import fs from "node:fs";
import path from "node:path";
import { COORD, HERE } from "./live.mjs";
export const SHABBOS = path.join(COORD, "shabbos.json");
export const OFFTIMES_FILE = path.resolve(process.env.HL_OFFTIMES_FILE || path.join(HERE, "offtimes.json"));
// The one reader of the switch (fail safe ON): off only when shabbos.json is an object whose enabled is exactly false.
export function shabbosEnabled() {
  let v; try { v = JSON.parse(fs.readFileSync(SHABBOS, "utf8")); } catch { return true; }
  return !(v && typeof v === "object" && !Array.isArray(v) && v.enabled === false);
}
```
  `pause-io.mjs`: `export { SHABBOS, shabbosEnabled, OFFTIMES_FILE } from "./offtimes-io.mjs";` and its one writer:

```js
// coord.mjs shabbos on|off, its one writer: a toggle rewrites, never deletes; the last write wins. -> the file
export function writeShabbos({ enabled, by }, now = Date.now()) {
  retried(() => writeAtomic(SHABBOS, JSON.stringify({ enabled: enabled === true, changed_at: now, by_session: by }, null, 2)));
  return SHABBOS;
}
```
  (`pause-io` needs `SHABBOS` locally too: `import { SHABBOS } from "./offtimes-io.mjs";`.) coord.mjs: `shabbosCmd(args,
  env)` as M2 (no tick is triggered); `main`: `else if (sub === "shabbos") { const r = await shabbosCmd(argv.slice(1));
  await write(`${r.text}\n`); return r.code; }`; add `"shabbos"` to the error branch at `:641` and a header line
  `shabbos [on|off|status]  Shabbat mode (one global switch, default on): <coord>/shabbos.json`. helpers.mjs: as M3.

- [ ] **Step 4: Run the file, then the full suite; expect PASS.**
- [ ] **Step 5: Commit** `offtimes-io.mjs`, `pause-io.mjs`, `coord.mjs`, `tests/helpers.mjs`, `tests/shabbos.test.mjs`: `feat(shabbat): the shabbos switch (fail safe on) and coord.mjs shabbos`

---

### Task S1a: the generator, testable without the calendar library

**Goal:** `tools/offtimes-lib.mjs` (pure, no imports) and `tools/gen-offtimes.mjs` (the CLI that loads the library from
a path). Tested with a fake calendar object; no network.

**Files:** Create `tools/offtimes-lib.mjs`, `tools/gen-offtimes.mjs`,
`claude/skills/handoff-launch/tests/offtimes-gen.test.mjs` (imports `../../../../tools/offtimes-lib.mjs`).

**Interfaces produced:**
- `YOM_TOV`: `[[monthKey, day, label]]` = `TISHREI 1 rosh-hashana`, `TISHREI 2 rosh-hashana`, `TISHREI 10 yom-kippur`,
  `TISHREI 15 sukkot`, `TISHREI 22 shemini-atzeret`, `NISAN 15 pesach`, `NISAN 21 pesach-7`, `SIVAN 6 shavuot`
  (Israel; Chol HaMoed and Hoshana Rabba are not in it). Labels are the only `kind` words, plus `shabbat`.
- `offDays(H, {from, to, city = "Jerusalem"}) -> [{date: "YYYY-MM-DD", label, start, end}]`: every Saturday and every
  `YOM_TOV` date in `[Jan 1 from, Dec 31 to]`; `start` = sunset on the eve, `end` = nightfall (`tzeit(8.5)`) on the day.
  `H` needs only: `H.Location.lookup(city)`, `new H.HDate(date)` / `new H.HDate(day, monthNumber, year)`, `.greg()`,
  `.getFullYear()`, `H.months[key]`, `new H.Zmanim(location, date, false)`, `.sunset()`, `.tzeit(8.5)`.
- `mergeDays(days) -> [{start, end, kind}]`, `tableErrors(table) -> [string]`,
  `buildTable({intervals, version, license, location, generated, until}) -> table`.
- CLI: `node tools/gen-offtimes.mjs --hebcal <dir of @hebcal/core> --from 2026 --to 2030 [--city Jerusalem] [--out <file>]`;
  without `--out` it prints the JSON. Exit 2 with a usage line on bad arguments; exit 1 when `tableErrors` is non-empty.

**MUST**
- M1: `mergeDays` merges intervals whose next `start <= ` current `end` (RH 1-2 and an adjacent Shabbat become one),
  keeps non-adjacent ones apart (Pesach day 1 on Thursday and the next Shabbat), sorts by start, and its `kind` is the
  labels joined by `+` in start order, ties by label name. Test: `"mergeDays: adjacent days merge, Chol HaMoed keeps them apart, kind labels"`.
- M2: `tableErrors` reports: `tz` not `Asia/Jerusalem`, non-finite `until`, unsorted or overlapping intervals,
  `start >= end`, a duration outside 20-80 h, an empty `kind`. Test: `"tableErrors: each broken table is named"`.
- M3: `offDays` with a fake `H` returns the Saturdays and the in-range `YOM_TOV` dates with eve-sunset/day-nightfall
  times. Test: `"offDays with a fake calendar: Saturdays, the Israel Yom Tov list, sunset of the eve to nightfall"`.
- M4: the CLI without `--hebcal` exits 2 and prints `usage: node tools/gen-offtimes.mjs --hebcal <dir> --from <year> --to <year> [--city <name>] [--out <file>]`.
  Test: `"gen-offtimes: no --hebcal is a usage error"` (spawn `process.execPath` on the file, no network).

- [ ] **Step 1: Write the failing tests.** The fake calendar (pure; the dates are the fake's own):

```js
const UTC = (y, m, d, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));
const YT = { "5787-7-1": [2026, 9, 12], "5787-7-2": [2026, 9, 13], "5787-7-10": [2026, 9, 21], "5787-7-15": [2026, 9, 26], "5787-7-22": [2026, 10, 3] };
const fakeH = {
  months: { TISHREI: 7, NISAN: 1, SIVAN: 3 },
  Location: { lookup: (c) => (c === "Jerusalem" ? { name: c } : null) },
  HDate: class { constructor(a, m, y) { this.k = a instanceof Date ? null : `${y}-${m}-${a}`; } getFullYear() { return 5787; } greg() { const g = YT[this.k]; return g ? new Date(g[0], g[1] - 1, g[2], 12) : new Date(1900, 0, 1); } },
  Zmanim: class { constructor(loc, d) { this.d = d; } sunset() { return UTC(this.d.getFullYear(), this.d.getMonth() + 1, this.d.getDate(), 15, 30); } tzeit() { return UTC(this.d.getFullYear(), this.d.getMonth() + 1, this.d.getDate(), 16, 15); } },
};
```
  With `offDays(fakeH, {from: 2026, to: 2026})`: 52 `shabbat` days (2026 has 52 Saturdays: Jan 3 .. Dec 26); the five
  Tishrei dates labelled; the RH 1 day (`2026-09-12`) has `start = UTC(2026,9,11,15,30)` and `end = UTC(2026,9,12,16,15)`.
  `mergeDays` of that output: one interval from `UTC(2026,9,11,15,30)` to `UTC(2026,9,13,16,15)` whose kind splits to
  `["rosh-hashana", "shabbat"]`; `2026-09-27` noon (Chol HaMoed) lies in no interval.

- [ ] **Step 2: Run, expect FAIL:** `timeout 300 node --test "claude/skills/handoff-launch/tests/offtimes-gen.test.mjs"`

- [ ] **Step 3: Implement** `tools/offtimes-lib.mjs`. The two subtle parts in full:

```js
export const TZ = "Asia/Jerusalem";
const DAY = 864e5;
const noonLocal = (ms) => { const d = new Date(ms); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12); }; // that calendar date, any host TZ
export function offDays(H, { from, to, city = "Jerusalem" }) {
  const loc = H.Location.lookup(city);
  if (!loc) throw new Error(`unknown city ${city}`);
  const first = Date.UTC(from, 0, 1), last = Date.UTC(to, 11, 31), out = [];
  const day = (ms, label) => ({ date: new Date(ms).toISOString().slice(0, 10), label,
    start: new H.Zmanim(loc, noonLocal(ms - DAY), false).sunset().getTime(), end: new H.Zmanim(loc, noonLocal(ms), false).tzeit(8.5).getTime() });
  for (let ms = first; ms <= last; ms += DAY) if (new Date(ms).getUTCDay() === 6) out.push(day(ms, "shabbat"));
  const hy0 = new H.HDate(new Date(from, 0, 1, 12)).getFullYear(), hy1 = new H.HDate(new Date(to, 11, 31, 12)).getFullYear();
  for (let hy = hy0; hy <= hy1; hy++) for (const [m, d, label] of YOM_TOV) {
    const g = new H.HDate(d, H.months[m], hy).greg(), ms = Date.UTC(g.getFullYear(), g.getMonth(), g.getDate());
    if (ms >= first && ms <= last) out.push(day(ms, label));
  }
  return out;
}
export function mergeDays(days) {
  const s = [...days].sort((a, b) => a.start - b.start || a.label.localeCompare(b.label)), out = [];
  for (const d of s) {
    const cur = out.at(-1);
    if (cur && d.start <= cur.end) { cur.end = Math.max(cur.end, d.end); if (!cur.labels.includes(d.label)) cur.labels.push(d.label); }
    else out.push({ start: d.start, end: d.end, labels: [d.label] });
  }
  return out.map(({ start, end, labels }) => ({ start, end, kind: labels.join("+") }));
}
```
  `buildTable` returns `{source: `@hebcal/core ${version}`, license, tz: TZ, location: city, generated, until,
  intervals}`; `until = Date.UTC(to, 11, 31)` (conservative: every interval starting before it is in the table).
  `gen-offtimes.mjs`: parse args; read `<dir>/package.json` (`version`, `license`, `exports["."].import` or `module`);
  `const H = await import(pathToFileURL(path.join(dir, entry)).href)`; `offDays` -> `mergeDays` -> `buildTable` ->
  `tableErrors` (non-empty: print them, exit 1); also check that each Hebrew year fully inside the range has all 8
  `YOM_TOV` dates (else exit 1); write with tmp + rename to `--out`, or print.

- [ ] **Step 4: Run the file, then the full suite; expect PASS.**
- [ ] **Step 5: Commit** `tools/offtimes-lib.mjs`, `tools/gen-offtimes.mjs`, `tests/offtimes-gen.test.mjs`: `feat(shabbat): the off-time table generator (dev only)`

---

### Task S1b (host step): install (option A), generate `offtimes.json`, commit it with its test

**Who:** the controller or a sonnet worker on the host (needs the network). Not Codex.

**License:** the user chose option A (ruling 1): GPL-2.0 `@hebcal/core` as a dev-only tool, never committed or shipped;
the table records `source` (version) and `license`.

**Files:** Create `claude/skills/handoff-launch/offtimes.json`, `claude/skills/handoff-launch/tests/offtimes-table.test.mjs`.

**MUST**
- M1: `@hebcal/core` is installed at an exact version in an isolated directory OUTSIDE the repo (the session scratchpad),
  with `--ignore-scripts`. Its `package.json` `license` is read and recorded; the report quotes it.
- M2: the generated table passes the generator's own checks, and its `source` is `@hebcal/core <exact version>`,
  `license` the package's, `tz` `Asia/Jerusalem`, `location` `Jerusalem`, `until >= Date.UTC(2030, 11, 31)`.
- M3: the table test passes: `"offtimes.json: sorted, merged, every Friday-sunset interval of 2026-2030, the Israel Yom
  Tov list, kind labels"`, including the Chol HaMoed absences.
- M4: nothing from `node_modules`, no `package.json` or lock file enters the repo.

- [ ] **Step 1:** in `<scratchpad>/hebcal`: `npm init -y`, then `npm view @hebcal/core version` and
  `npm install --ignore-scripts --no-audit --no-fund --save-exact @hebcal/core@<that version>`. Read
  `node_modules/@hebcal/core/package.json` (`version`, `license`) and `dist/esm/index.d.ts`: confirm the members
  S1a's `H` uses (`Location.lookup`, `HDate`, `months`, `Zmanim(gloc, date, useElevation)`, `sunset()`, `tzeit(angle)`).
  If a member differs, fix `offDays` (a reviewed one-line change in `tools/offtimes-lib.mjs`) and re-run S1a's test.
- [ ] **Step 2:** `node tools/gen-offtimes.mjs --hebcal "<scratchpad>/hebcal/node_modules/@hebcal/core" --from 2026 --to 2030 --out claude/skills/handoff-launch/offtimes.json`
- [ ] **Step 3: Write the table test** (`tests/offtimes-table.test.mjs`):

```js
const T = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "offtimes.json"), "utf8"));
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(ms).map((p) => [p.type, p.value]));
const dateOf = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; }, hourOf = (ms) => Number(parts(ms).hour);
const noon = (d) => Date.parse(`${d}T09:30:00Z`); // late morning in Jerusalem, winter or summer
const cover = (ms) => T.intervals.find((o) => o.start <= ms && ms < o.end);
const LABELS = ["shabbat", "rosh-hashana", "yom-kippur", "sukkot", "shemini-atzeret", "pesach", "pesach-7", "shavuot"];
test("offtimes.json: sorted, merged, every Friday-sunset interval of 2026-2030, the Israel Yom Tov list, kind labels", () => {
  assert.match(T.source, /^@hebcal\/core \d+\.\d+\.\d+$/); assert.equal(T.tz, "Asia/Jerusalem"); assert.ok(T.until >= Date.UTC(2030, 11, 31));
  T.intervals.forEach((o, i) => {
    assert.ok(o.start < o.end && (i === 0 || o.start > T.intervals[i - 1].end), `order at ${i}`);
    assert.ok(hourOf(o.start) >= 15 && hourOf(o.start) <= 20 && hourOf(o.end) >= 17 && hourOf(o.end) <= 21, `sunset/nightfall hours at ${i}`);
    assert.ok(o.end - o.start >= 20 * 3600e3 && o.end - o.start <= 80 * 3600e3, `length at ${i}`);
    assert.ok(o.kind.split("+").every((k) => LABELS.includes(k)), o.kind);
  });
  for (let ms = Date.UTC(2026, 0, 3); ms <= Date.UTC(2030, 11, 28); ms += 7 * 864e5) assert.ok(cover(noon(new Date(ms).toISOString().slice(0, 10))), `Saturday ${new Date(ms).toISOString()}`);
  for (const k of LABELS.slice(1)) assert.equal(T.intervals.filter((o) => o.kind.split("+").includes(k)).length, 5, k); // 2026..2030: once a year (RH's two days in one interval)
  const span = (d) => { const o = cover(noon(d)); assert.ok(o, d); return [dateOf(o.start), dateOf(o.end)]; };
  assert.deepEqual(span("2026-09-12"), ["2026-09-11", "2026-09-13"]); // Shabbat + Rosh Hashana 1-2, merged
  assert.deepEqual(span("2026-09-21"), ["2026-09-20", "2026-09-21"]); // Yom Kippur
  assert.deepEqual(span("2026-09-26"), ["2026-09-25", "2026-09-26"]); // Sukkot day 1 (Shabbat)
  assert.deepEqual(span("2026-10-03"), ["2026-10-02", "2026-10-03"]); // Shemini Atzeret / Simchat Torah (Shabbat)
  assert.deepEqual(span("2027-04-22"), ["2027-04-21", "2027-04-22"]); // Pesach day 1
  assert.deepEqual(span("2027-04-28"), ["2027-04-27", "2027-04-28"]); // Pesach day 7
  assert.deepEqual(span("2027-06-11"), ["2027-06-10", "2027-06-12"]); // Shavuot (Friday) + Shabbat, merged
  // Chol HaMoed (and the days around Yom Tov) are working days
  for (const d of ["2026-09-14", "2026-09-22", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2027-04-23", "2027-04-25", "2027-04-26", "2027-04-27"]) assert.equal(cover(noon(d)), undefined, d);
});
```
  (Dates checked by calendar arithmetic: Rosh Hashana 5787 is Saturday 2026-09-12; 5787 is a leap year, so Rosh
  Hashana 5788 is 2026-09-12 + 385 days = Saturday 2027-10-02, and 15 Nisan 5787 = 163 days earlier = Thursday
  2027-04-22; Shavuot falls on the weekday of 16 Nisan, Friday 2027-06-11.)
- [ ] **Step 4:** `timeout 300 node --test "claude/skills/handoff-launch/tests/offtimes-table.test.mjs"` PASS; then the full suite.
- [ ] **Step 5: Commit** `offtimes.json`, `tests/offtimes-table.test.mjs`: `feat(shabbat): the off-time table 2026-2030 (@hebcal/core <version>, generated)`

---

### Task S2: the working-time weekly line, the table readers, the table alerts

**Goal:** the weekly line measures working time over the table (merged intervals); the 5-hour line is plain; while
the mode is on, a missing or invalid table alerts once a day and a table under 60 days left alerts once.

**Files:** Modify `pace-lib.mjs` (`:95-103` workingMinutes, `:115` five-hour call, new exports after `:109`);
`offtimes-io.mjs` (readers); `pause-io.mjs` (re-exports); `pace-io.mjs` (`:9-10` imports, `:36-43` recomputePace);
`recover.mjs` (`:691-694` readTickState, `:1083` tick). Tests: `tests/pace-lib.test.mjs` (append), create
`tests/offtimes-pace.test.mjs`.

**Read first:** `pace-lib.mjs:65-73` (`newest`), `:95-134`, `:141-154`; `pace-io.mjs:34-43`; `recover.mjs:140-146`
(`raiseAlert`), `:691-694`, `:1026-1032`, `:1076-1095`; `tests/pace-lib.test.mjs:254-259`.

**Interfaces produced:** pace-lib (pure): `offStatus(table, now) -> {state: "missing"} | {state: "invalid"} | {state:
"ok", until, daysLeft, intervals}`, `offIntervals(table, now) -> [{start, end, kind}]`, `OFFTIMES_EXPIRY_TEXT({until,
daysLeft})`, `OFFTIMES_BAD_TEXT(state)`. offtimes-io: `readOffTimes(now) -> [{start, end, kind}]` (`[]` when the mode
is off), `offTimesStatus(now) -> offStatus | null` (null when the mode is off). `pause-io` and `pace-io` re-export both
from `offtimes-io` (`pace-io` never imports `pause-io`). `recomputePace({..., off})`.

**MUST**
- M1 (carry, red first): `workingMinutes` merges overlapping or duplicate intervals, in any order: never negative, never
  double-counted. Test: `"workingMinutes: overlapping, duplicate and unsorted off intervals are merged"`.
- M2: `offStatus` is `missing` for null or a non-object (an absent or unparsable file reads as null), `invalid` for a
  wrong `tz`, non-finite `until`, non-array `intervals`, any interval with non-finite or `start >= end`, unsorted or
  overlapping intervals; else `ok` (`[]` intervals is ok). `offIntervals` is the `ok` intervals while `now < until`,
  else `[]`. Tests: `"missing table: no off-time"` (pure: `offIntervals(null, NOW)` is `[]`, `offStatus(null, NOW).state`
  is `missing`) and `"a bad or expired table: no off-time"` (pure cases; plus `PI.readOffTimes` in a sandbox child: the
  default table `[]`, a table with one interval returns it, `shabbos.json {enabled:false}` `[]`).
- M3: the weekly `week_ahead` is the same at an interval's start and at `end - 1 min` for the same reading, while the
  5-hour `ahead` keeps moving. Test: `"weekly pace over a Shabbat: allowedW stands still from sunset to nightfall"`
  (pure `paceState` with `off`). Note for the test: `newest()` (`pace-lib.mjs:69-73`) drops a reading whose window has
  reset (`resets_at * 1000 <= now`) or whose `ts` is over a minute ahead of `now`: give each of the two readings its own
  `ts = now` and a 5-hour `resets_at` after that `now` (e.g. `now + 2 h`, in seconds), and a `week_resets_at` after
  `end`.
- M4: `recomputePace` passes `off` (default `readOffTimes(now)`) to `paceState`.
- M5: an unrestricted tick, mode on: a `missing`/`invalid` table raises `raiseAlert({name: "offtimes", text:
  OFFTIMES_BAD_TEXT(state)})` when `ts.offtimes_bad_at` is absent or 24 h old, and sets it to `now`; an `ok` table with
  `daysLeft < 60` raises `OFFTIMES_EXPIRY_TEXT` once per `until` (`ts.offtimes_alerted = until`). Mode off: nothing. A
  dry run raises none and prints `would alert: ...`. Tests (sandbox): `"one alert at 59 days left"` (and none at 61
  days, none on the second tick); `"a missing table alerts once a day"` (delete `sb.offtimes`: one alert; second tick
  none; with `offtimes_bad_at` rewritten to 25 h ago, one more; `shabbos off`: none); `"the sandbox default table raises
  nothing"`.
- M6: an unrestricted tick inside an off interval skips `powerTick` and `paceTick` (ruling 9). Test: `"the tick in
  off-time writes no pace.json"`.

- [ ] **Step 1: Write the failing tests.** M1:

```js
test("workingMinutes: overlapping, duplicate and unsorted off intervals are merged", () => {
  assert.equal(P.workingMinutes(0, 100 * MIN, [{ start: 0, end: 100 * MIN }, { start: 0, end: 100 * MIN }]), 0); // was -100
  assert.equal(P.workingMinutes(0, 100 * MIN, [{ start: 30 * MIN, end: 70 * MIN }, { start: 10 * MIN, end: 50 * MIN }]), 40); // was 20
  assert.equal(P.workingMinutes(0, 100 * MIN, [{ start: 10 * MIN, end: 20 * MIN }, { start: 20 * MIN, end: 30 * MIN }, { start: NaN, end: 5 }]), 80);
});
```

- [ ] **Step 2: Run, expect FAIL:** `timeout 600 node --test "claude/skills/handoff-launch/tests/pace-lib.test.mjs" "claude/skills/handoff-launch/tests/offtimes-pace.test.mjs"`

- [ ] **Step 3: Implement.** `pace-lib.mjs` (replace `:95-103`; comment: "the off intervals are clipped, sorted and
  merged, so overlapping input never counts twice"):

```js
export function workingMinutes(fromMs, toMs, off = []) {
  if (!(toMs > fromMs)) return 0;
  const cut = (off || []).filter((o) => o && Number.isFinite(o.start) && Number.isFinite(o.end))
    .map((o) => [Math.max(fromMs, o.start), Math.min(toMs, o.end)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let m = toMs - fromMs, a0 = null, b0 = null;
  for (const [a, b] of cut) {
    if (b0 !== null && a <= b0) { b0 = Math.max(b0, b); continue; }
    if (b0 !== null) m -= b0 - a0;
    a0 = a; b0 = b;
  }
  if (b0 !== null) m -= b0 - a0;
  return m / MIN;
}
// The off table's intervals, checked: sorted, finite, start < end, none overlapping the next -> a copy, or null. One
// bad interval invalidates the table: a generator bug is not data to guess around.
function checkedIntervals(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const o of list) {
    if (!isObj(o) || !Number.isFinite(o.start) || !Number.isFinite(o.end) || !(o.start < o.end)) return null;
    if (out.length && !(o.start > out.at(-1).end)) return null;
    out.push({ start: o.start, end: o.end, kind: typeof o.kind === "string" && o.kind ? o.kind : "off" });
  }
  return out;
}
// offtimes.json (parsed, or null when absent or unparsable) -> its state; the tick alerts on missing/invalid.
export function offStatus(table, now) {
  if (!isObj(table)) return { state: "missing" };
  const intervals = table.tz === "Asia/Jerusalem" && Number.isFinite(table.until) ? checkedIntervals(table.intervals) : null;
  if (!intervals) return { state: "invalid" };
  return { state: "ok", until: table.until, daysLeft: Math.floor((table.until - now) / 864e5), intervals };
}
// The intervals while the table is valid and not expired, else [] (fail open).
export const offIntervals = (table, now) => { const s = offStatus(table, now); return s.state === "ok" && now < s.until ? s.intervals : []; };
export const OFFTIMES_EXPIRY_TEXT = ({ until, daysLeft }) => `The Shabbat/Yom Tov table (offtimes.json) ends on ${new Date(until).toISOString().slice(0, 10)}: ${Math.max(0, daysLeft)} days left. After that there is no Shabbat pause and the weekly pace counts plain time. Regenerate it with tools/gen-offtimes.mjs (coordinator.md, "Shabbat mode").`;
export const OFFTIMES_BAD_TEXT = (state) => `Shabbat mode is on but the Shabbat/Yom Tov table (offtimes.json) is ${state === "missing" ? "missing or unreadable" : "invalid"}: there is no Shabbat pause and the weekly pace counts plain time. Reinstall the handoff-launch skill or regenerate the table (coordinator.md, "Shabbat mode"). This alert repeats daily.`;
```
  `:115`: `windowElapsed(r5.resets_at, 300, now)` (no `off`: ruling 5); update the comment at `:95-97`.
  `offtimes-io.mjs` (add `import { readJson } from "./live.mjs"` and `import { offStatus, offIntervals } from "./pace-lib.mjs"`):

```js
// The off intervals now ([] for a missing, invalid or expired table, and while Shabbat mode is off).
export const readOffTimes = (now = Date.now()) => (shabbosEnabled() ? offIntervals(readJson(OFFTIMES_FILE, null), now) : []);
// The table's state for the tick's alerts; null while Shabbat mode is off.
export const offTimesStatus = (now = Date.now()) => (shabbosEnabled() ? offStatus(readJson(OFFTIMES_FILE, null), now) : null);
```
  `pause-io.mjs` and `pace-io.mjs`: `export { readOffTimes, offTimesStatus } from "./offtimes-io.mjs";` (pace-io also
  imports `readOffTimes`); in `recomputePace` add the parameter `off = undefined` and call `paceState({ ..., off: off ??
  readOffTimes(now) })`. `recover.mjs`: `readTickState` keeps `offtimes_alerted: t.offtimes_alerted ?? null` and
  `offtimes_bad_at: Number.isFinite(t.offtimes_bad_at) ? t.offtimes_bad_at : null`; a new `offTimesTick({dryRun, now,
  ts})` after `paceTick` in `tick` (unrestricted only) per M5 (lines: `offtimes.json is <state> - alert <file>`,
  `offtimes.json has <n> days left - alert <file>`); at `:1083`: `const offNow = !repoKey &&
  PI.readOffTimes(now).some((o) => o.start <= now && now < o.end);` and run `powerTick`/`paceTick` only when
  `!repoKey && !offNow`.

- [ ] **Step 4: Run both files, then the full suite; expect PASS** (the existing `windowElapsed` test at `:254-259` stays green).
- [ ] **Step 5: Commit** `pace-lib.mjs`, `offtimes-io.mjs`, `pause-io.mjs`, `pace-io.mjs`, `recover.mjs` and the two test files: `feat(shabbat): working-time weekly pace over offtimes.json; merged off intervals; table alerts`

---

### Task S3: the `shabbat` pause source and the lead-hour gate text

**Goal:** from 60 min before an interval's start to its end, every session is paused by a `shabbat` source; the
Agent gate and the lane Stop say the source's own text.

**Files:** Modify `pause-lib.mjs` (`:21-38`, new exports); `pace-lib.mjs` (`:267-268` gateDecision); `pause-io.mjs`
(`:33-36` readSources); `hooks/coord.mjs` (`:205`, `:223`, `:235-240`, `:470`, a new `offNear` near `:233`). Tests:
`tests/pause-lib.test.mjs`, `tests/pace-lib.test.mjs`, create `tests/shabbat-source.test.mjs`.

**Read first:** `pause-lib.mjs:15-42`; `pace-lib.mjs:259-273`; `pause-io.mjs:32-41`; `coord.mjs:180-240`, `:455-481`;
`tests/pause-pacetoggle.test.mjs:20-27` (source order without `off` must not change).

**Interfaces produced:** `Q.SHABBAT_LEAD_MIN = 60`, `Q.SHABBAT_GRACE_MIN = 10`, `Q.SHABBAT_BEGUN_TEXT`,
`Q.shabbatSource(off, now) -> source | null`; `activeSources({..., off = []}, now)`; a paused `pauseFor` answer also
carries `text`, `start`, `end` when its source has them. Source shape: `{source: "shabbat", reason: "Shabbat/Yom Tov
(<kind>)", scope: "all", since: <ISO of start - 60 min>, windows: [], ends: false, text, start, end}`.

**MUST**
- M1: `shabbatSource` is null at `start - 61 min` and at `end`; active at `start - 60 min`, at `start` and at `end - 1`;
  `pauseFor` is paused for high, normal and low. It comes FIRST in `activeSources` (a lane's line then says `shabbat`
  when a manual pause also runs). Test: `"shabbat source: active 60 min before sunset to nightfall, every priority"`.
- M2: the text is `Shabbat/Yom Tov in N min: finish the current step, save state, end your turn.` with `N = ceil((start
  - now) / 1 min)` before `start`, and `SHABBAT_BEGUN_TEXT` from `start`. `gateDecision` denies with `pause.text` when it
  is a non-empty string, else `PAUSE_TEXT` as now. Test: `"gate text in the lead hour"` (pure, and `coordRun(sb,
  ["agent-gate"], {input: {tool_name: "Agent", session_id: "probe-1"}, env: {CLAUDE_CODE_ENTRYPOINT: "sdk-cli"}})` with a
  table at `sb.offtimes` whose interval starts in 30 min: the deny reason matches `/^Shabbat\/Yom Tov in (29|30) min: /`).
- M3: `readSources` passes `off: readOffTimes(now)` (imported from `offtimes-io.mjs`); with `shabbos.json {enabled: false}` there is no `shabbat` source
  and `readOffTimes` is `[]`. Test: `"off: no shabbat source and plain 7-day pacing"` (sandbox child; spec S0's test, ruling 8).
- M4: `coord.mjs` pre-filter `offNear(now)`: true when the table file at `process.env.HL_OFFTIMES_FILE ||
  <SKILL>/offtimes.json` has an interval with `start - 60 min <= now < end` (no other check: `readSources` decides).
  `pauseStatePossible` and `agentGate`'s `files` also return/count true on it. Test: `"coord.mjs offNear's table path
  and lead are pause-io's and pause-lib's"` (same env: `OFFTIMES === PI.OFFTIMES_FILE`, as `tests/lane-hooks.test.mjs`
  pins `CFG`/`COORD`; and `OFF_LEAD_MS === Q.SHABBAT_LEAD_MIN * 60000`).
- M5: the lane Stop's save prompt (`coord.mjs:205`) is `due.p.text` when present; `dueLine`'s line (`:223`) carries
  `end: p.end` when finite. Test: in `tests/shabbat-source.test.mjs`, `"a lane's Stop in the lead hour: the Shabbat text, then a {paused} line with source shabbat and end"`
  (model on `tests/pause-hooks.test.mjs`'s lane Stop tests).

- [ ] **Step 1: Write the failing tests** (pure ones first; NOW-relative `off = [{start: S, end: E, kind: "shabbat"}]`).
- [ ] **Step 2: Run, expect FAIL:** `timeout 900 node --test "claude/skills/handoff-launch/tests/pause-lib.test.mjs" "claude/skills/handoff-launch/tests/pace-lib.test.mjs" "claude/skills/handoff-launch/tests/shabbat-source.test.mjs"`
- [ ] **Step 3: Implement.** `pause-lib.mjs`:

```js
export const SHABBAT_LEAD_MIN = 60, SHABBAT_GRACE_MIN = 10;
export const SHABBAT_BEGUN_TEXT = "Shabbat/Yom Tov has begun: save state and end your turn now. Work resumes when the user asks (/broadcast resume).";
// off: readOffTimes's intervals (sorted). Active from SHABBAT_LEAD_MIN before an interval's start to its end; scope all;
// never ends by itself (the user resumes, S5).
export function shabbatSource(off, now) {
  const o = (off || []).find((x) => x.start - SHABBAT_LEAD_MIN * MIN <= now && now < x.end);
  if (!o) return null;
  const n = Math.ceil((o.start - now) / MIN);
  return { source: "shabbat", reason: `Shabbat/Yom Tov (${o.kind || "shabbat"})`, scope: "all", since: new Date(o.start - SHABBAT_LEAD_MIN * MIN).toISOString(),
    windows: [], ends: false, start: o.start, end: o.end,
    text: n > 0 ? `Shabbat/Yom Tov in ${n} min: finish the current step, save state, end your turn.` : SHABBAT_BEGUN_TEXT };
}
```
  `activeSources({..., off = []}, now)`: `const sh = shabbatSource(off, now); if (sh) out.push(sh);` before the manual
  source. `pauseFor`'s paused answer adds `...(typeof s.text === "string" ? { text: s.text } : {}), ...(Number.isFinite(s.end) ? { start: s.start, end: s.end } : {})`
  (the not-paused answer and every other source's answer stay as they are). `pace-lib gateDecision`: `if (pause?.paused)
  return { deny: typeof pause.text === "string" && pause.text ? pause.text : PAUSE_TEXT(pause.reason, pause.ends !== false) };`.
  `coord.mjs`: `const OFFTIMES = path.resolve(process.env.HL_OFFTIMES_FILE || path.join(SKILL, "offtimes.json"));`
  and `const offNear = (now = Date.now()) => { const t = readJson(OFFTIMES, null); return Array.isArray(t?.intervals) &&
  t.intervals.some((o) => o && o.start - OFF_LEAD_MS <= now && now < o.end); };` with `export const OFF_LEAD_MS = 60 * 60000;`
  (a literal: coord.mjs loads no module on this path; the pin test keeps it equal to `SHABBAT_LEAD_MIN`); export all three.
- [ ] **Step 4: Run the files, then the full suite; expect PASS.**
- [ ] **Step 5: Commit** `pause-lib.mjs`, `pace-lib.mjs`, `pause-io.mjs`, `coord.mjs` and the three test files: `feat(shabbat): the shabbat pause source, its lead hour and the gate text`

---

### Task S4: the close at sunset: the tick's `{paused}` line, the guarded close, the force close after the grace

**Goal:** from `start`, every open lane gets the tick's own `{paused}` line once; idle lanes close at once (guarded);
a lane still open at `start + 10 min` is closed by force; the manifest rows carry `source: "shabbat"`.

**Files:** Modify `pause-lib.mjs` (new exports; `laneRow` `:145-146`); `recover.mjs` (`pauseScan` `:728-779`,
`manifestTick` `:864`). Create `tests/shabbat-close.test.mjs`.

**Read first:** `recover.mjs:706-779` (pauseScan, countSkip, PAUSE_CLOSE); `:614-637` (guardedCloseResult);
`live.mjs:495-508` (killTree), `:381-391` (workedAfterPause); `tests/pause-close.test.mjs:1-41` (bg-lane pattern).

**Interfaces produced:**

```js
// pause-lib.mjs
// The tick's own {paused} line for a lane at sunset (or right before its force close: forced true).
export const shabbatLine = (e, src, at, { forced = false } = {}) => ({ paused: e.id, name: e.name, group: e.group ?? null, at,
  reason: src.reason, source: "shabbat", windows: [], end: src.end, by: "tick", ...(forced ? { forced: true } : {}) });
// Due once per interval: the lane's newest line is not a shabbat line written at or after this source's since.
export const shabbatLineDue = (prev, src) => !(prev && prev.source === "shabbat" && Date.parse(prev.at) >= Date.parse(src.since));
export const shabbatForceDue = (src, now) => !!src && src.source === "shabbat" && now >= src.start + SHABBAT_GRACE_MIN * MIN;
```
  `laneRow(e, {priority, reason, source = null})` adds `source`.

**MUST**
- M1: in `pauseScan`, the sources are read first; with a `shabbat` source and `now >= start`, every open entry (not
  closed, liveness not `gone`) whose `shabbatLineDue` holds gets `shabbatLine(e, sh, V.now())` appended (line
  `Shabbat/Yom Tov: {paused} written for <tag>`; dry run `would write the Shabbat {paused} line of <tag>`, nothing
  appended); then the registry is read for the candidates as today. Nothing is written in the lead hour.
- M2: a line with `by: "tick"` skips the 1-minute wait: `pausedAt = Date.parse(line.at) - (line.by === "tick" ? L.MIN : 0)`
  goes to `pauseCloseDue`; the guarded close then judges the lane (an idle lane closes, a busy one waits).
- M3: when `shabbatForceDue(sh, now)`, a candidate is closed by force: liveness `unknown` keeps its existing counted
  skip; a pending ladder keeps its skip line and, under force only, is also counted (`countSkip`), so it is alerted at
  the second tick and the quiet watcher (S5) stops ticking for it; a bg lane without `bg_id` is skipped and counted;
  else (not dry run) append `shabbatLine(e, sh, V.now(), {forced: true})`, then `V.killTree(e, why, "close",
  PAUSE_CLOSE)` with `why = Shabbat/Yom Tov began <m> min ago: closed by force after the 10-min grace`; a failed kill is
  counted. Dry run: `would force-close <tag>: <why>`. A lane first seen past the grace (the machine slept through
  sunset) is closed through this path even when idle, and its line says "by force": expected (ruling 4).
- M4: one window-mode force close on Windows. Test: `"a window lane busy past the grace is force-closed (Windows
  only)"`, `{ skip: process.platform !== "win32" }`, modelled on `tests/pause-close.test.mjs:223` (`host()` from
  `tests/helpers.mjs:179`): a window lane on that host with a busy transcript, table `start = now - 11 min`; one tick:
  a `kill_intent`, `{closed, pause: true}`, and the host process gone; `h.kill()` in `finally`. Other platforms: the bg
  tests cover the logic; the window kill itself is `killTree`'s (already tested).
- M5: `closed.push({e, priority, reason, source})` with the line's source; `manifestTick` passes `source` to `laneRow`.
- Tests (all in `tests/shabbat-close.test.mjs`, bg lanes as in `tests/pause-close.test.mjs`, the table at `sb.offtimes`
  written NOW-relative):
  - `"sunset closes idle lanes at once and a busy one after the grace"`: interval `start = now - 3 min`; idle lane I and
    busy lane B (an outstanding tool call). Tick 1: both get a `{paused, source: "shabbat", by: "tick"}` line; I is
    closed (`{closed, pause: true}`), B has no `kill_intent`. Rewrite the table with `start = now - 11 min`; tick 2: B
    gets a `forced: true` line, a `kill_intent` and `{closed, pause: true}`; output matches `/^closed B \(gen 1\): Shabbat\/Yom Tov began 11 min ago: closed by force/m`.
  - `"the manifest rows carry source shabbat"`: after the test above's ticks, `paused.json` rows for I and B have
    `source: "shabbat"`.
  - `"the lead hour writes no line and closes nothing"`: `start = now + 30 min`; one tick; no `{paused}` line, no kill.
  - `"a bg lane without a bg_id is counted and alerted, never killed"` (Review Focus 4): past the grace, two ticks: no
    `kill_intent`, one alert file.
  - `"a dry run at sunset writes nothing"`: `--dry-run` prints `would write the Shabbat {paused} line of`; registry unchanged.

- [ ] **Step 1: Write the failing tests.** **Step 2:** `timeout 900 node --test "claude/skills/handoff-launch/tests/shabbat-close.test.mjs"` FAIL.
- [ ] **Step 3: Implement** (the loop part of `pauseScan`, after `const st = V.sessionState(e);`):

```js
      // S4: a tick's own line waits no minute (the guarded close below judges the lane itself)
      const pausedAt = (Date.parse(line.at) || 0) - (line.by === "tick" ? L.MIN : 0);
      const due = Q.pauseCloseDue({ pausedAt, pause, lastAt: Date.parse(st.lastReal), now }), force = Q.shabbatForceDue(sh, now);
      if (!due.close && !force) continue;
      if (lv.state === "unknown") { /* unchanged skip + countSkip */ }
      if (L.pendingLadders(reg.lines).some((p) => p.id === e.id)) { /* unchanged line */ if (force) out.push(...countSkip(e, "its loop ladder is pending", { dryRun, ts })); continue; }
      if (force) {
        const r = shabbatForce(e, sh, { dryRun, now, tag });
        out.push(r.line);
        if (r.skipped) out.push(...countSkip(e, r.line.replace(/^(?:skip close of |not closed )[^:]+: /, ""), { dryRun, ts }));
        if (r.closed) closed.push({ e, priority, reason: sh.reason, source: "shabbat" });
        continue;
      }
```
```js
// S4: past the grace an open lane is closed by force. A fresh {paused} line first, so the resume never reads its last
// minutes as work after its pause (live.mjs workedAfterPause); killTree re-probes and kills a running session only.
function shabbatForce(e, sh, { dryRun, now, tag }) {
  const why = `Shabbat/Yom Tov began ${Math.round((now - sh.start) / L.MIN)} min ago: closed by force after the ${Q.SHABBAT_GRACE_MIN}-min grace`;
  if (e.mode === "bg" && !e.bg_id) return { line: `skip close of ${tag}: a background lane without a recorded bg_id cannot be stopped`, closed: false, skipped: true };
  if (dryRun) return { line: `would force-close ${tag}: ${why}`, closed: false, skipped: false };
  V.append(Q.shabbatLine(e, sh, V.now(), { forced: true }));
  const k = V.killTree(e, why, "close", PAUSE_CLOSE);
  return { line: `${k.closed ? "closed" : "not closed"} ${tag}: ${why}${k.line === "closed" ? "" : ` - ${k.line}`}`, closed: k.closed, skipped: !k.closed };
}
```
  `shabbatMark({dryRun, sh})` per M1 (`V.primeLiveness` on the open entries first). Update the comment above `pauseScan`.
- [ ] **Step 4: Run the file, `tests/pause-close.test.mjs`, then the full suite; expect PASS.**
- [ ] **Step 5: Commit** `pause-lib.mjs`, `recover.mjs`, `tests/shabbat-close.test.mjs`: `feat(shabbat): close every lane at sunset, by force after a 10-min grace`

---

### Task S5: no automatic resume; the resume request; the quiet watcher; the manifest at nightfall

**Goal:** a row paused before an off interval ended relaunches only after the user's resume request made after that
end (or with the mode off), whatever its source (ruling 7); the watcher is quiet in off-time, starts before it while a
lane is open, and never treats waiting rows as pending; nightfall raises no alert (ruling 3).

**Files:** Modify `pause-lib.mjs` (`resumePlan` `:117-140`, new exports); `pause-io.mjs` (resume request,
`watchNeeded` `:128`); `recover.mjs` (`resumeScan` `:806-813`, `manifestTick` `:889-894`, `watcherTick` `:1048-1061`);
`hooks/coord.mjs` (`resumeCmd` `:275-283`, `watchStep` `:527-549`). Create `tests/shabbat-resume.test.mjs`; append pure
tests to `tests/pause-lib.test.mjs`.

**Read first:** `pause-lib.mjs:117-140`; `pause-io.mjs:126-128`; `recover.mjs:793-841`, `:849-906`, `:1045-1061`;
`coord.mjs:273-283`, `:517-549`; `tests/watch.test.mjs:1-40` (the `watch --once` pattern).

**Interfaces produced:** `PI.RESUME_REQUEST` (`<coord>/pause/resume-request.json`), `PI.writeResumeRequest(now) -> {at,
enabled}`, `PI.readResumeRequest() -> {at, enabled} | null` (null unless `at` is finite); `Q.userWaitEnd`,
`Q.awaitsUser`, `Q.SHABBAT_WAIT_WHY`, `Q.SHABBAT_WATCH_AHEAD_MIN = 120`; `resumePlan({..., off = [], resumeReq =
null})`; pending items carry `end`; `watchNeeded({active, openLanes, pending, offSoon = false})`.

```js
// pause-lib.mjs - ruling 7. p: {pausedAt (ms), end (ms|null: a shabbat line's own interval end)}; off: readOffTimes's
// intervals. The end a row waits past: its own end, or the latest off interval that ended after it paused (end <= now).
// null: the row does not wait for the user.
export function userWaitEnd(p, off, now) {
  let w = Number.isFinite(p.end) ? p.end : null;
  for (const o of off || []) if (o.end > p.pausedAt && o.end <= now && !(w >= o.end)) w = o.end;
  return w;
}
// Does the row wait for the user's resume? req: the resume request {at, enabled} or null. A request counts when it came
// after the pause and at or after that end, or with the mode switched off.
export function awaitsUser(p, off, req, now) {
  const w = userWaitEnd(p, off, now);
  return w !== null && !(Number.isFinite(req?.at) && req.at > p.pausedAt && (req.enabled === false || req.at >= w));
}
export const SHABBAT_WAIT_WHY = "Shabbat/Yom Tov: waits for the user's resume (/broadcast resume)";
export const SHABBAT_WATCH_AHEAD_MIN = 120;
```

**MUST**
- M1: `resumePlan`: after the `q.paused` check, `awaitsUser(p, off, resumeReq, now)` waits with `SHABBAT_WAIT_WHY`;
  ready rows keep the existing order (high first, oldest pause) and cap. Pure tests: `"nightfall resumes nothing"`
  (interval ended, a `shabbat` row, no request), `"resume request relaunches every shabbat row, high first"` (rows
  high/normal/low, a request after `end`), `"a request during the interval does not count"`, `"resume after shabbos off
  relaunches at once"` (`{at: before end, enabled: false}`), `"a manual row whose timed pause expired on Shabbat waits
  for the user"` (source `manual`, `pausedAt` before the interval, interval ended, no request: waits; a request after
  `end`: relaunches), and a row paused after the last interval ended does not wait.
- M2: `resumeScan` maps `end: Number.isFinite(line.end) ? line.end : null` and passes `off: PI.readOffTimes(now),
  resumeReq: PI.readResumeRequest()`. Integration (`tests/shabbat-resume.test.mjs`): a closed row (line `end` in the
  past): `tick --dry-run` has no `would relaunch`; after `coordRun(sb, ["resume"])` it has `would relaunch <name> after
  its pause`.
- M3: `coord.mjs resume` writes the request (`{at: now, enabled: shabbosEnabled()}`, atomic, its one writer) and adds a
  line: when `PI.readSources(now)` has a `shabbat` source: `resume request recorded, but Shabbat/Yom Tov is still on: run
  /broadcast resume again after nightfall`; else `resume request recorded: lanes paused over Shabbat/Yom Tov relaunch
  now`. Existing output lines are unchanged.
- M4: `watchStep`, right after loading its modules: when `IO.readOffTimes(now)` has an interval with `start <= now <
  end`, it does no pace and no power work; it runs `tick()` (no 5-min back-off) only while an open entry that is not in
  `tick-state.alerted` and not `gone` exists; else it returns `{lines: [], ticked: false, last}`. Test: `"the watcher
  does not tick during off-time"` (no open lane: `watch --once` prints `watch: one step done`, no `last-tick.txt`, no
  `pace.json`; with an open lane: `watch: one step done (a tick ran)`).
- M5: `watchStep`'s and `watcherTick`'s pending lists drop rows where `Q.awaitsUser({pausedAt: Date.parse(line.at) ||
  0, end: line.end}, off, PI.readResumeRequest(), now)`. Test: `"after nightfall the watcher stops with only waiting
  rows"` (`watch --once` -> `watch: stopped - nothing is paused or waiting to resume`; the tick starts no watcher).
- M6 (ruling 3, review I2): `manifestTick` raises no `HAND_RESUME_TEXT` alert for a pause that spanned an off interval
  (`spanned = Q.userWaitEnd({pausedAt: Date.parse(m.paused_at) || 0}, off, now) !== null`): while the user has not
  resumed it leaves `hand_alerted` unset; once `!awaitsUser(...)` it sets `hand_alerted: V.now(), hand_via: "resume"`
  without an alert (the resume printed the `claude --resume` lines, S6 M2). Other pauses keep today's alert. Test:
  `"nightfall raises no hand-opened alert; the resume marks it without one"` (a `paused.json` with a hand row,
  `paused_at` before an interval that ended 1 min ago, no source: tick -> no alert file, no `hand_alerted`; `resume`
  then tick -> `hand_via: "resume"`, still no alert file).
- M7 (review M2): `watchNeeded` is also true when `offSoon && openLanes > 0`; `watcherTick` computes `offSoon =
  off.some((o) => o.start - SHABBAT_WATCH_AHEAD_MIN * MIN <= now && now < o.end)`, counts open lanes when `active ||
  offSoon`, and says `watcher started (Shabbat/Yom Tov begins within 2 h)` when that is the reason; `watchStep` does not
  stop while `offSoon` and an open (not gone) lane exists. Tests: `"the last working tick before Shabbat starts the
  watcher"` (interval `start = now + 90 min`, one open bg lane: that line; no open lane: none) and `"the watcher keeps
  running before Shabbat while a lane is open"` (`watch --once` -> `watch: one step done`).
- Future hook (no code now): a nightfall notice, if ever wanted, belongs in `watchStep`'s first normal-branch step after
  the quiet branch stops returning (no off interval running while a row `awaitsUser`).

- [ ] **Step 1: Write the failing tests.** **Step 2:** `timeout 900 node --test "claude/skills/handoff-launch/tests/pause-lib.test.mjs" "claude/skills/handoff-launch/tests/shabbat-resume.test.mjs"` FAIL.
- [ ] **Step 3: Implement.** The quiet branch of `watchStep`:

```js
  const off = IO.readOffTimes(now);
  if (off.some((o) => o.start <= now && now < o.end)) { // S5: off-time - no pace, no power, no relaunch; a tick only while an open lane is left to close (S4)
    V.forgetLiveness();
    const reg = V.readRegistry(), ts = readJson(PI.TICK_STATE, {}), alerted = new Set(Array.isArray(ts.alerted) ? ts.alerted : []);
    if (!reg.entries.some((e) => !reg.closed.has(e.id) && !alerted.has(e.id) && V.liveness(e, reg).state !== "gone")) return { lines: [], ticked: false, last };
    const lines = (await mod("recover.mjs")).tick();
    return { lines, ticked: true, last: { at: now, acted: lines.some((l) => /^(closed|relaunched) /.test(l)) } };
  }
```
  The existing `IO.recomputePace` and power lines move below this branch; `off` is reused for M5 and M7. The manifest
  part (`recover.mjs:891-894`):

```js
  const pz = { pausedAt: Date.parse(m.paused_at) || 0 }, spanned = Q.userWaitEnd(pz, off, now) !== null; // off, req read once at the top
  if (!active && hands.length && !m.hand_alerted) {
    if (!spanned) { /* today's alert, unchanged */ }
    else if (!Q.awaitsUser(pz, off, req, now)) m = { ...m, hand_alerted: V.now(), hand_via: "resume" }; // ruling 3: the resume printed the lines
  }
```
  Update the comments of `resumePlan`, `watchNeeded`, `manifestTick`, `watchStep` and `watcherTick`.
- [ ] **Step 4: Run the files, `tests/watch.test.mjs`, `tests/pause-resume-tick.test.mjs`, `tests/pause-resume.test.mjs`, then the full suite; expect PASS.**
- [ ] **Step 5: Commit** `pause-lib.mjs`, `pause-io.mjs`, `recover.mjs`, `coord.mjs`, `tests/pause-lib.test.mjs`, `tests/shabbat-resume.test.mjs`: `feat(shabbat): no automatic resume after off-time; the resume request; a quiet watcher`

---

### Task S6: `/broadcast resume` phrases, docs, the release checkpoint

**Files:** Modify `claude/skills/broadcast/SKILL.md` (`:3` description, `:27-30` resume verb, Notes);
`claude/skills/handoff-launch/coordinator.md` (a `## Shabbat mode` section after `## Pausing`, `:164`; the `## Files`
list at `:7`); `claude/skills/handoff-launch/SKILL.md` (one bullet under Pausing, `:275-289`);
`tests/broadcast-skill.test.mjs` (append).

**MUST**
- M1: the broadcast description keeps `Use when ...` and adds the resume triggers, including the phrases "resume from
  before Shabbat / Yom Tov", "resume from pre-shabbos", "resume after chag", "before shabbat". Test: `"broadcast SKILL.md
  description matches the resume phrases"` (the frontmatter line contains each phrase, case-insensitive; the existing
  `^---\nname: broadcast\ndescription: Use when .+\n---\n` still matches).
- M2: the `resume` verb says: after a Shabbat/Yom Tov the lanes relaunch on this command; if it prints `Shabbat/Yom Tov
  is still on`, send no resume message and tell the user to run it after nightfall; then print the hand-opened rows'
  `claude --resume <session_id> -n <name>` lines from `<coord>/paused.json` (or the newest `paused-*.json` when already
  archived), as `restart` does. After an off interval this printout is the only channel for them: the tick raises no
  alert (ruling 3).
- M3: `coordinator.md` "Shabbat mode" documents: the table (path, shape, fail open, the alert, regeneration with
  `tools/gen-offtimes.mjs` and the license from ruling 1), the switch and `coord.mjs shabbos`, the source (lead hour,
  scope, texts), the close (tick line, grace, force), the user-wait rule (ruling 7), the quiet watcher and its look-ahead (ruling 9),
  the table alerts (daily when missing or invalid, once under 60 days), no alert at nightfall (ruling 3), and the
  external Clean View marker. No personal paths.
- M4: the full suite passes.

- [ ] **Steps:** write the test, see it fail, edit the three docs, see it pass, run the full suite, commit the four
  files: `docs(shabbat): /broadcast resume after Shabbat/Yom Tov; Shabbat mode in the coordinator docs`.

#### Release checkpoint (controller, after S6 is merged and installed)

Dry runs only; `<config>` is the live config dir; `<tmp>` a scratchpad folder. Report each command's real output.
1. `node "<config>/hooks/coord.mjs" shabbos status` -> `shabbos: on ...`. Confirm `<config>/skills/handoff-launch/offtimes.json`
   exists and `node --input-type=module -e "const PI = await import('file:///<config>/skills/handoff-launch/pause-io.mjs'); console.log(PI.readOffTimes().length, PI.offTimesStatus())"` prints a count over 250 and `state: "ok"` with `daysLeft` over 1000.
2. Injected lead hour: write `<tmp>/off-lead.json` = `{tz: "Asia/Jerusalem", until: now + 400 days, intervals: [{start:
   now + 30 min, end: now + 25 h, kind: "shabbat"}]}` (epoch ms). Run the gate with `HL_OFFTIMES_FILE=<tmp>/off-lead.json
   CLAUDE_CODE_ENTRYPOINT=sdk-cli` (sdk-cli: no `pause/seen` record is written) and stdin
   `{"tool_name":"Agent","session_id":"probe-1"}`: a deny with `Shabbat/Yom Tov in 30 min: ...`. `tick --dry-run` with
   the same env: no Shabbat line (lead hour).
3. Injected sunset past the grace: `<tmp>/off-now.json` with `start: now - 15 min`. `tick --dry-run`: one `would write the
   Shabbat {paused} line of <tag>` per open lane (none when no lane is open: say so); nothing written (registry line
   count unchanged).
4. `HL_OFFTIMES_FILE=<tmp>/off-now.json node "<config>/hooks/coord.mjs" pace --json`: `week_ahead` differs from the run
   without the variable while the 5-hour `ahead` is the same.
5. Delete `<tmp>` files. Close any window or tab opened.

### External task: Clean View `/shabbos` and the marker (not in this repo)

Lives in the live mod `<config>/mods/clean-view`; written by sonnet, one opus review (no Fable). Starts after S0 is
installed.
- **Command:** `/shabbos on|off|status` registered in the mod; it runs `node "<config>/hooks/coord.mjs" shabbos <arg>`
  and shows its one output line (preferred: one writer). If the mod writes the file itself it must write exactly
  `{enabled: bool, changed_at: <epoch ms>, by_session}` atomically (tmp + rename), never delete it; the last write wins.
- **Marker:** `✡ Shabbos on` / `✡ Shabbos off` in the band or the Session Viewer, Clean View Dark style, refreshed on the
  mod's own few-second refresh. Read `<config>/state/coord/shabbos.json` (or `<CLAUDE_CONFIG_DIR>/state/coord/...`)
  with the same rule as `shabbosEnabled()`: missing, unreadable, malformed, or `enabled` not exactly `false` = on.
- **Check:** toggle from one session, see the marker change in another within the refresh period; `coord.mjs shabbos
  status` agrees.
