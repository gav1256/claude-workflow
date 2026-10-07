// Batch B, Parts 4-5: the pure pause protocol (pause-lib.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as Q from "../pause-lib.mjs";
import { DEFAULTS } from "../recover-lib.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 6, 12, 0, 0), iso = (ms) => new Date(ms).toISOString();
const pace = (state, o = {}) => ({ updated: NOW, claude: { state, ahead: 22, week_ahead: 3, since: NOW - 5 * MIN, windows: { five_hour: { state, basis: "fresh" }, weekly: { state: "ok", basis: "fresh" } }, ...o } });
const cfg = { ...DEFAULTS };

test("sources: manual (until or none), the legacy pause.json, a fresh battery file, pace hold/exhausted; expired ones are off", () => {
  assert.deepEqual(Q.activeSources({}, NOW), []);
  assert.deepEqual(Q.activeSources({ manual: { until: null, by: "user", at: iso(NOW) } }, NOW).map((s) => [s.source, s.reason, s.scope]), [["manual", "manual pause", "all"]]);
  assert.equal(Q.activeSources({ manual: { until: iso(NOW + 30 * MIN) } }, NOW)[0].reason, "manual pause until 2026-10-06T12:30Z");
  assert.deepEqual(Q.activeSources({ manual: { until: iso(NOW - MIN) } }, NOW), []);
  assert.deepEqual(Q.activeSources({ legacy: { until: null } }, NOW).map((s) => s.source), ["manual"]); // the old shape is read
  assert.equal(Q.activeSources({ manual: { until: null }, legacy: { until: null } }, NOW).length, 1);
  assert.deepEqual(Q.activeSources({ battery: { at: iso(NOW - 2 * MIN), pct: 19, ac: false } }, NOW).map((s) => [s.source, s.reason, s.scope]), [["battery", "battery 19%", "all"]]);
  assert.deepEqual(Q.activeSources({ battery: { at: iso(NOW - 11 * MIN), pct: 19 } }, NOW), []); // not refreshed: off
  const h = Q.activeSources({ pace: pace("hold") }, NOW)[0];
  assert.deepEqual([h.source, h.reason, h.scope, h.windows], ["pace", "pace hold (5h +22 / week +3)", "normal-low", ["five_hour"]]);
  assert.equal(Q.activeSources({ pace: pace("exhausted") }, NOW)[0].scope, "all");
  for (const st of ["ok", "slow"]) assert.deepEqual(Q.activeSources({ pace: pace(st) }, NOW), []);
});

test("pauseFor scope by priority: manual and battery pause everyone; pace hold normal and low only; exhausted everyone", () => {
  const S = (o) => Q.activeSources(o, NOW);
  const table = (o) => ["high", "normal", "low"].map((p) => Q.pauseFor(p, S(o)).paused);
  assert.deepEqual(table({ manual: { until: null } }), [true, true, true]);
  assert.deepEqual(table({ battery: { at: iso(NOW), pct: 15 } }), [true, true, true]);
  assert.deepEqual(table({ pace: pace("hold") }), [false, true, true]);
  assert.deepEqual(table({ pace: pace("exhausted") }), [true, true, true]);
  assert.deepEqual(table({}), [false, false, false]);
  assert.deepEqual(Q.pauseFor("high", S({ pace: pace("hold") })), { paused: false, reason: null, source: null, windows: [], since: null });
  assert.equal(Q.pauseFor("low", S({ manual: { until: null }, pace: pace("hold") })).source, "manual"); // the first source that covers it
  assert.equal(Q.pauseFor("low", S({ manual: { until: null, at: iso(NOW - MIN) } })).since, iso(NOW - MIN));
  assert.equal(Q.pauseFor("low", S({ battery: { at: iso(NOW), since: iso(NOW - 30 * MIN), pct: 15 } })).since, iso(NOW - 30 * MIN)); // the low battery's start, not its last refresh
});

test("pausedLineDue: a first {paused} line, or a new one when the newest predates the source that pauses the lane now", () => {
  const p = { paused: true, reason: "manual pause", since: iso(NOW - 10 * MIN) };
  assert.equal(Q.pausedLineDue(null, p), true);
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 5 * MIN) }, p), false); // written under this pause
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 60 * MIN) }, p), true); // written under an earlier one
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 60 * MIN) }, { ...p, since: null }), false);
});

test("pausedLineOf: the newest {paused} line naming the launch (id, or its name by hand) at or after its launch", () => {
  const e = { id: "A@2", name: "A", launched_at: iso(NOW - 60 * MIN) };
  const lines = [{ paused: "A", at: iso(NOW - 90 * MIN) }, { paused: "A@2", at: iso(NOW - 10 * MIN), reason: "r1" }, { paused: "A", at: iso(NOW - 5 * MIN), reason: "r2" }, { paused: "B@1", at: iso(NOW) }];
  assert.equal(Q.pausedLineOf(lines, e).reason, "r2");
  assert.equal(Q.pausedLineOf(lines.slice(0, 1), e), null); // before its launch
});

test("pauseCloseDue: 1 min old first; close while paused; once lifted, only a lane that did nothing after its {paused} line", () => {
  const p = { paused: true, reason: "manual pause" }, off = { paused: false, reason: null };
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 30000, pause: p, lastAt: NaN, now: NOW }).close, false);
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 2 * MIN, pause: p, lastAt: NOW - 2 * MIN + 20000, now: NOW }), { close: true, why: "paused (manual pause)" });
  assert.equal(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: off, lastAt: NOW - 5 * MIN + 20000, now: NOW }).close, true); // still open, idle since
  assert.equal(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: off, lastAt: NaN, now: NOW }).close, true);
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: off, lastAt: NOW - MIN, now: NOW }).close, false); // typed into by hand
});

test("pausedLanes: the newest entry per lane with a {paused} line that is closed or gone; an older generation or an open running one is not", () => {
  const mk = (name, gen, o = {}) => ({ id: `${name}@${gen}`, name, repo: "r", group: "g", generation: gen, launched_at: iso(NOW - (10 - gen) * 60 * MIN), mode: "window", ...o });
  const a1 = mk("A", 1), a2 = mk("A", 2), b1 = mk("B", 1), c1 = mk("C", 1), d1 = mk("D", 1), d2 = mk("D", 2);
  const lines = [{ paused: "A@1", at: iso(NOW - 8 * 60 * MIN) }, { paused: "A@2", at: iso(NOW - 20 * MIN) }, { closed: "A", id: "A@2", pause: true, at: iso(NOW - 10 * MIN) },
    { paused: "B@1", at: iso(NOW - 20 * MIN) }, { paused: "C@1", at: iso(NOW - 20 * MIN) }, { paused: "D@1", at: iso(NOW - 20 * MIN) }, { closed: "D", id: "D@1", pause: true, at: iso(NOW - 15 * MIN) }];
  const closed = new Set(["A@2", "D@1"]);
  const out = Q.pausedLanes({ entries: [a1, a2, b1, c1, d1, d2], lines, closed, gone: (e) => e.id === "B@1", now: NOW });
  assert.deepEqual(out.map((p) => [p.e.id, p.closedAt]), [["A@2", NOW - 10 * MIN], ["B@1", NOW - 20 * MIN]]); // C running; D relaunched (D@2 is newer)
  // a launch of A in flight ({starting} newer than A@2, under 5 min old): left out; a 6-min-old one (a dead launcher) is not
  const starting = (m) => [...lines, { starting: null, name: "A", group: "g", pid_file: null, at: iso(NOW - m * MIN) }];
  assert.deepEqual(Q.pausedLanes({ entries: [a2, b1], lines: starting(1), closed, gone: (e) => e.id === "B@1", now: NOW }).map((p) => p.e.id), ["B@1"]);
  assert.deepEqual(Q.pausedLanes({ entries: [a2, b1], lines: starting(6), closed, gone: (e) => e.id === "B@1", now: NOW }).map((p) => p.e.id), ["A@2", "B@1"]);
});

const item = (id, o = {}) => ({ e: { id, name: id, mode: "window" }, priority: "normal", source: "manual", windows: [], pausedAt: NOW - 30 * MIN, closedAt: NOW - 20 * MIN, ...o });
const none = () => ({ paused: false, reason: null });

test("resumePlan: high first, then the oldest pause; capped at max_resumes_per_tick; a still-paused lane waits; min_pause_min for pace closes", () => {
  const pending = [item("L1", { priority: "low", pausedAt: NOW - 50 * MIN }), item("N2", { pausedAt: NOW - 20 * MIN }), item("N1", { pausedAt: NOW - 40 * MIN }), item("H1", { priority: "high" }), item("N3", { pausedAt: NOW - 10 * MIN })];
  let r = Q.resumePlan({ pending, pauseOf: none, pace: null, now: NOW, cfg });
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["H1", "N1", "N2"]);
  assert.deepEqual(r.wait.map((w) => [w.item.e.id, w.why]), [["N3", "max_resumes_per_tick 3: next tick"], ["L1", "max_resumes_per_tick 3: next tick"]]);
  assert.equal(r.mode, "full");
  r = Q.resumePlan({ pending, pauseOf: (p) => ({ paused: p !== "high", reason: "pace hold (x)" }), pace: null, now: NOW, cfg });
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["H1"]);
  assert.match(r.wait[0].why, /^its pause still applies \(pace hold \(x\)\)$/);
  const fresh = pace("ok", { windows: { five_hour: { state: "ok", basis: "fresh" }, weekly: { state: "ok", basis: "fresh" } } }).claude;
  r = Q.resumePlan({ pending: [item("P", { source: "pace", windows: ["five_hour"], closedAt: NOW - 10 * MIN })], pauseOf: none, pace: fresh, now: NOW, cfg });
  assert.deepEqual(r.relaunch, []); assert.match(r.wait[0].why, /minimum pause 15 min/);
  r = Q.resumePlan({ pending: [item("M", { closedAt: NOW - MIN })], pauseOf: none, pace: null, now: NOW, cfg }); // manual: no minimum
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["M"]);
  assert.deepEqual(Q.resumePlan({ pending: [], pauseOf: none, pace: null, now: NOW, cfg }), { relaunch: [], wait: [], probe: null, mode: "none" });
});

test("repause back-off: a lane the pace pauses again within 6 h of its last pace relaunch waits 2x, then 4x (the cap)", () => {
  const cfg15 = { ...cfg, min_pause_min: 15 };
  assert.equal(Q.repauseCount(null, NOW), 1);
  assert.equal(Q.repauseCount({ n: 1, at: NOW - 60 * MIN }, NOW - 10 * MIN), 2);
  assert.equal(Q.repauseCount({ n: 2, at: NOW - 60 * MIN }, NOW - 10 * MIN), 3);
  assert.equal(Q.repauseCount({ n: 3, at: NOW - 7 * 60 * MIN }, NOW), 1); // over 6 h: a new series
  assert.equal(Q.repauseCount({ n: 3, at: NOW }, NOW - MIN), 1); // paused before that relaunch: not a re-pause
  assert.deepEqual([1, 2, 3, 4].map((n) => Q.minPauseFor(n, cfg15)), [15, 30, 60, 60]);
  const fresh = { state: "ok", windows: { five_hour: { state: "ok", basis: "fresh" } } };
  const p = item("P", { source: "pace", windows: ["five_hour"], closedAt: NOW - 20 * MIN, minPause: 30 });
  assert.deepEqual(Q.resumePlan({ pending: [p], pauseOf: none, pace: fresh, now: NOW, cfg: cfg15 }).relaunch, []);
  assert.match(Q.resumePlan({ pending: [p], pauseOf: none, pace: fresh, now: NOW, cfg: cfg15 }).wait[0].why, /minimum pause 30 min/);
  assert.equal(Q.resumePlan({ pending: [{ ...p, closedAt: NOW - 31 * MIN }], pauseOf: none, pace: fresh, now: NOW, cfg: cfg15 }).relaunch.length, 1);
});

test("probe resume: a pace pause that ended on a stale 5-hour reading relaunches one window lane, then waits probe_wait_min for a fresh reading", () => {
  const stale = { state: "slow", windows: { five_hour: { state: "slow", basis: "stale" }, weekly: { state: "ok", basis: "fresh" } } };
  const pending = [item("B", { source: "pace", windows: ["five_hour"], priority: "high", closedAt: NOW - 30 * MIN, e: { id: "B", name: "B", mode: "bg" } }),
    item("W", { source: "pace", windows: ["five_hour"], closedAt: NOW - 30 * MIN }), item("X", { source: "pace", windows: ["five_hour"], closedAt: NOW - 30 * MIN })];
  let r = Q.resumePlan({ pending, pauseOf: none, pace: stale, now: NOW, cfg });
  assert.deepEqual([r.mode, r.relaunch.map((p) => p.e.id), r.probe], ["probe", ["W"], { id: "W", at: NOW }]); // the high bg lane writes no reading
  r = Q.resumePlan({ pending: pending.filter((p) => p.e.id !== "W"), pauseOf: none, pace: stale, now: NOW + 5 * MIN, cfg, probe: { id: "W", at: NOW } });
  assert.deepEqual([r.relaunch, r.probe], [[], { id: "W", at: NOW }]);
  r = Q.resumePlan({ pending: pending.filter((p) => p.e.id !== "W"), pauseOf: none, pace: stale, now: NOW + 11 * MIN, cfg, probe: { id: "W", at: NOW } });
  assert.deepEqual(r.relaunch.map((p) => p.e.id), ["X"]); // no fresh reading in 10 min: the next lane is probed
  const freshNow = { state: "ok", windows: { five_hour: { state: "ok", basis: "fresh" }, weekly: { state: "ok", basis: "stale" } } };
  r = Q.resumePlan({ pending, pauseOf: none, pace: freshNow, now: NOW, cfg, probe: { id: "W", at: NOW - MIN } });
  assert.deepEqual([r.mode, r.relaunch.length, r.probe], ["full", 3, null]); // a fresh reading confirmed: a full resume
});

test("needsProbe: a 5-hour reset ends a 5-hour pause in full; a weekly reset with the 5-hour reading stale or unknown is a probe", () => {
  const w = (b5) => ({ windows: { five_hour: { basis: b5 }, weekly: { basis: "none" } } });
  assert.equal(Q.needsProbe(w("fresh"), ["weekly"]), false);
  assert.equal(Q.needsProbe(w("none"), ["five_hour"]), false);
  assert.equal(Q.needsProbe(w("none"), ["weekly"]), true);
  assert.equal(Q.needsProbe(w("stale"), ["five_hour"]), true);
  assert.equal(Q.needsProbe(null, ["weekly"]), true);
});

test("the manifest: upsert keeps the newest generation, resumed rows, archive once no source is active and every closed row resumed", () => {
  const e = (gen) => ({ id: `A@${gen}`, name: "A", repo: "r", group: "g", generation: gen, session_id: `s${gen}`, worktree: "/w/a", branch: "a", handoff: "/h.md", launched_at: iso(NOW + gen) });
  let m = Q.upsertRows(null, [Q.laneRow(e(2), { priority: "normal", reason: "manual pause" })], NOW, "how");
  assert.deepEqual([m.paused_at, m.how_to_resume, m.sessions.length], [iso(NOW), "how", 1]);
  m = Q.upsertRows(m, [Q.laneRow(e(1), { priority: "normal", reason: "x" })], NOW); // an older generation never replaces it
  assert.equal(m.sessions[0].generation, 2);
  m = Q.upsertRows(m, [Q.handRow({ session_id: "hand-1234-5678", cwd: "/p", reason: "manual pause" })], NOW);
  assert.deepEqual(m.sessions.map((r) => [r.key, r.closed]), [["lane:r|g|A", true], ["hand:hand-1234-5678", false]]);
  assert.equal(Q.archiveDue(m, false), false);
  m = Q.markResumed(m, () => e(3));
  assert.equal(m.sessions[0].resumed_at, iso(NOW + 3));
  assert.equal(Q.archiveDue(m, true), false);
  assert.equal(Q.archiveDue(m, false), true);
  assert.equal(Q.archiveName(m), "paused-2026-10-06-1200.json");
  assert.match(Q.HAND_RESUME_TEXT([m.sessions[1]]), /claude --resume hand-1234-5678 \(in \/p\)/);
});

test("parseUntil: no end, minutes, hours, until HH:MM (today, or tomorrow when past); garbage is an error", () => {
  const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime(); // local noon: time-zone independent
  assert.deepEqual(Q.parseUntil([], NOW), { until: null });
  assert.deepEqual(Q.parseUntil(["30m"], NOW), { until: iso(NOW + 30 * MIN) });
  assert.deepEqual(Q.parseUntil(["2h"], NOW), { until: iso(NOW + 120 * MIN) });
  const at = (h, m, plusDay) => { const x = new Date(NOW); x.setHours(h, m, 0, 0); if (plusDay) x.setDate(x.getDate() + 1); return x.toISOString(); };
  const later = new Date(NOW + 90 * MIN), earlier = new Date(NOW - 90 * MIN);
  assert.deepEqual(Q.parseUntil(["until", `${later.getHours()}:${String(later.getMinutes()).padStart(2, "0")}`], NOW), { until: at(later.getHours(), later.getMinutes(), false) });
  assert.deepEqual(Q.parseUntil(["until", `${earlier.getHours()}:${String(earlier.getMinutes()).padStart(2, "0")}`], NOW), { until: at(earlier.getHours(), earlier.getMinutes(), true) });
  for (const bad of [["x"], ["0m"], ["until"], ["until", "25:00"], ["30m", "x"]]) assert.ok(Q.parseUntil(bad, NOW).error, bad.join(" "));
});

test("F1 pauseCloseDue: an active pause closes only a line of this pause that the lane did nothing after", () => {
  const p = { paused: true, reason: "r", since: iso(NOW - 10 * MIN) };
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 30 * MIN, pause: p, lastAt: NOW - 30 * MIN, now: NOW }), { close: false, why: "paused line predates this pause" });
  assert.deepEqual(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: p, lastAt: NOW - MIN, now: NOW }), { close: false, why: "worked after its paused line" });
  assert.equal(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: p, lastAt: NaN, now: NOW }).close, true);
  assert.equal(Q.pauseCloseDue({ pausedAt: NOW - 5 * MIN, pause: { ...p, since: null }, lastAt: NOW - 5 * MIN + 20000, now: NOW }).close, true);
});

test("F2 pausedLineDue: a line over 1 min old is due again when now is given", () => {
  const p = { paused: true, since: null };
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 2 * MIN) }, p, NOW), true);
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 30000) }, p, NOW), false);
  assert.equal(Q.pausedLineDue({ at: iso(NOW - 2 * MIN) }, p), false); // no now: the old rule
});

test("F3 pausedLanes: activeAfter skips; a closed line counts only with pause: true; a gone lane with no closed line stays pending", () => {
  const e = { id: "A@1", name: "A", repo: "r", group: "g", generation: 1, launched_at: iso(NOW - 60 * MIN) };
  const paused = { paused: "A@1", at: iso(NOW - 20 * MIN) };
  const run = (lines, o = {}) => Q.pausedLanes({ entries: [e], lines: [paused, ...lines], closed: new Set(lines.some((l) => l.closed) ? ["A@1"] : []), now: NOW, ...o }).length;
  const c = { closed: "A", id: "A@1", at: iso(NOW - 10 * MIN) };
  assert.equal(run([{ ...c, pause: true }]), 1);
  assert.equal(run([{ ...c, pause: true }], { activeAfter: () => true }), 0);
  assert.equal(run([c]), 0); // closed for another reason
  assert.equal(run([], { gone: () => true }), 1); // reboot while paused
});

test("m1-m3: needsProbe(null) probes; a future battery file is off; parseUntil never throws a RangeError", () => {
  assert.equal(Q.needsProbe(null, ["five_hour"]), true);
  assert.equal(Q.needsProbe(undefined, ["five_hour"]), true);
  assert.deepEqual(Q.activeSources({ battery: { at: iso(NOW + 5 * MIN), pct: 10 } }, NOW), []);
  assert.ok(Q.parseUntil(["99999999999999h"], NOW).error);
});
