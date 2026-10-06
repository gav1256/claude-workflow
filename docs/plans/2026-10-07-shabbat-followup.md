# Follow-up to batch B: Shabbat and Yom Tov (spec addendum and task list)

Status: deferred - last priority (2026-10-07). Batch B ships without it; its only trace there is the
seam `pace-lib.mjs workingMinutes(fromMs, toMs, off = [])` (batch B plan, Task 3), through which the weekly pace line
already measures its window. This file records the requirements so the work can start from them later. It needs its own
review and the user's approval before a full plan.

## Requirements (2026-10-06/07)

1. **No work on Shabbat or Yom Tov.** Off-time = Shabbat (Friday sunset to Saturday nightfall) and the Yom Tov days of
   the Israel schedule (Rosh Hashana days 1-2, Yom Kippur, Sukkot day 1, Shemini Atzeret, Pesach days 1 and 7, Shavuot),
   each from the eve's sunset to nightfall, in Asia/Jerusalem. Adjacent days merge into one interval.
2. **The weekly pace line counts working time only.** `allowedW = target x min(1, (working_elapsed + grace) /
   working_total)` over the 7-day window, both measured with `workingMinutes(..., off)`. The 5-hour line is unchanged.
3. **Pause before Shabbat/Yom Tov with a finish-up lead** of one hour, so running work can finish before the close. A
   pause source `shabbat` (derived from the table like `pace`, nothing
   stored) is active from 60 min before an interval's start to its end, and pauses every lane. In the lead hour the
   Agent gate denies dispatches with: "Shabbat/Yom Tov in N min: finish the current step, save state, end your turn."
   A lane that ended its turn and wrote `{paused}` is closed at once (the pause close); from the start (sunset) every
   open lane is closed - a lane still busy then gets the tick's own `{paused}` line (source `shabbat`) and is closed by
   the guarded path, by force after a short grace (open point for review: the grace, and whether force is wanted).
4. **No automatic resume at nightfall.** The `shabbat` rows wait until the user, in a session afterwards, asks to resume
   ("resume from before Shabbat / Yom Tov" or similar); then every paused session reopens and continues. That is
   `/broadcast resume` (its description must match phrases like "resume from pre-shabbos", "resume after chag", "before
   shabbat"): `coord.mjs resume` records a resume request, the tick relaunches every paused lane of the manifest, and
   the hand-opened rows get their `claude --resume` commands.
5. **The watcher is quiet during off-time:** no tick, no relaunch, no power or pace work; it never resumes `shabbat`
   rows on its own (they are not "waiting" for the watcher's stop rule until a resume request exists).
6. **The calendar is data, not a dependency.** A table `claude/skills/handoff-launch/offtimes.json` for about 2026-2030
   (`{source: "@hebcal/core <version>", tz: "Asia/Jerusalem", generated, until, intervals: [{start, end, kind}]}`,
   epoch ms, sorted), generated once by a dev script with `@hebcal/core` pinned (MIT: verify the license in an isolated
   inspection of the package and record the version). The hooks and the tick only read the JSON. A missing, invalid or
   expired table means no off-time (fail open); the tick raises one alert when it has under 60 days left.
7. **Shabbat mode, on by default, one global switch (2026-10-07).** `/shabbos on|off` from any session switches it for
   every session. Its state is always visible in the CLI through the clean-view mod (a "✡ Shabbos on" / "✡ Shabbos off"
   marker in its band or Session Viewer, in the Clean View Dark style). Off means plain 7-day pacing and no Shabbat
   pause; the calendar table stays as it is.

## Interfaces (to be fixed by the plan)

- **The switch (coordinator ruling, 2026-10-07).** `<coord>/shabbos.json` = `{enabled: bool, changed_at: <epoch ms>,
  by_session}`. A missing, unreadable or malformed file means enabled (fail safe on). Every reader goes through one
  helper, `pause-io.mjs shabbosEnabled() -> bool`: the `shabbat` pause source, the working-time weekly line
  (`readOffTimes`) and the watcher's quiet interval. Disabled: `readOffTimes` returns `[]` and there is no `shabbat`
  source.
- Writers: `coord.mjs shabbos on|off|status` writes atomically (tmp + rename) and prints the state. The clean-view mod
  registers `/shabbos` and either calls that CLI or writes the same JSON shape itself; a toggle only rewrites, never
  deletes, and the last write wins. The mod reads the same file for its marker on its own few-second refresh.
- `pace-io.mjs readOffTimes(now) -> [{start, end}]` (the table, or `[]`), passed to `paceState({..., off})` by every
  caller of `recomputePace`; `offTimesExpiry(now) -> {until, daysLeft}` for the alert.
- `pause-lib.mjs activeSources({..., off}, now)` gains the `shabbat` source `{source: "shabbat", reason, scope: "all",
  since: start - 60 min, text, start, end}`; `pauseFor` passes `text` through; the Agent gate denies with `pause.text`
  when present.
- `pause-io.mjs`: `pause/resume-request.json {at}` (written by `coord.mjs resume`, its one writer); `resumePlan` relaunches
  a `shabbat` row only after a resume request newer than its pause.
- `coord.mjs watchStep`: an early return during an off interval.
- `tools/gen-offtimes.mjs` (dev only): `node tools/gen-offtimes.mjs --hebcal <path to @hebcal/core> --from 2026 --to 2030`.

## Tasks (each with its tests; full code in the plan)

| # | Task | Tests (named) |
|---|---|---|
| S0 | The switch: `shabbosEnabled()`, `coord.mjs shabbos on`, `off`, `status`; every reader through the helper | "shabbos: a missing file is on"; "a malformed file is on"; "off: no shabbat source and plain 7-day pacing"; "coord.mjs shabbos off, status, on: the round trip" |
| S1 | The generator and the committed `offtimes.json`; the license check and the pinned version in the file's `source` | "offtimes.json: sorted, merged, every Friday-sunset interval of 2026-2030, the Israel Yom Tov list, kind labels" |
| S2 | The working-time weekly line: `readOffTimes`, `paceState({off})` from every caller; the < 60-day alert | "weekly pace over a Shabbat: allowedW stands still from sunset to nightfall"; "a missing or expired table: no off-time"; "one alert at 59 days left" |
| S3 | The `shabbat` source and its scope; the lead-hour gate text | "shabbat source: active 60 min before sunset to nightfall, every priority"; "gate text in the lead hour" |
| S4 | The close at sunset: the tick's `{paused}` line for a busy lane, the guarded close, the grace | "sunset closes idle lanes at once and a busy one after the grace"; "the manifest rows carry source shabbat" |
| S5 | No automatic resume: the resume request, `resumePlan`'s rule, the watcher's quiet interval and stop rule | "nightfall resumes nothing"; "resume request relaunches every shabbat row, high first"; "the watcher does not tick during off-time" |
| S6 | `/broadcast resume` trigger phrases, docs, the release checkpoint (dry run with an injected interval) | "broadcast SKILL.md description matches the resume phrases" |

External task (the clean-view lane, reopened by the coordinator when this work is built): `/shabbos` in the mod and the
"✡ Shabbos on/off" marker, against the interface above (`shabbos.json`, or `coord.mjs shabbos`). Not in this repo's
task list.
