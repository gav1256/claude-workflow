// S2: table readers, working-time pace and table alerts. Every child gets a sandbox and a fixed clock.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox } from "./helpers.mjs";
import * as P from "../pace-lib.mjs";

const MIN = 60000, DAY = 1440 * MIN, NOW = Date.UTC(2030, 0, 1), S = (ms) => Math.round(ms / 1000);
const skill = new URL("../", import.meta.url);
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); };
const table = (days, intervals = []) => ({ tz: "Asia/Jerusalem", until: NOW + days * DAY, intervals });
function ask(sb, code) {
  const script = `Date.now = () => ${NOW};
    const PI = await import(${JSON.stringify(new URL("pause-io.mjs", skill).href)});
    const IO = await import(${JSON.stringify(new URL("pace-io.mjs", skill).href)});
    const R = await import(${JSON.stringify(new URL("recover.mjs", skill).href)});
    console.log(JSON.stringify(${code}));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(skill), env: sb.env, encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim());
}
const tick = (sb, opts = {}) => {
  const out = ask(sb, `R.tick(${JSON.stringify(opts)})`).join("\n");
  assert.doesNotMatch(out, /tick failed:|error:/);
  return out;
};
const alerts = (sb) => {
  const dir = path.join(sb.coord, "alerts");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))) : [];
};
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "tick-state.json"), "utf8"));

test("a bad or expired table: no off-time", () => {
  const sb = sandbox();
  try {
    assert.deepEqual(ask(sb, `PI.readOffTimes(${NOW})`), []);
    const intervals = [{ start: NOW - MIN, end: NOW + MIN, kind: "shabbat" }];
    put(sb.offtimes, table(90, intervals));
    assert.deepEqual(ask(sb, `[PI.readOffTimes(${NOW}), IO.readOffTimes(${NOW})]`), [intervals, intervals]);
    assert.deepEqual(ask(sb, `[PI.offTimesStatus(${NOW}), IO.offTimesStatus(${NOW})]`), [P.offStatus(table(90, intervals), NOW), P.offStatus(table(90, intervals), NOW)]);
    for (const data of [table(0, intervals), { ...table(90, intervals), tz: "UTC" }, "{bad json"]) {
      put(sb.offtimes, data);
      assert.deepEqual(ask(sb, `PI.readOffTimes(${NOW})`), []);
    }
    fs.rmSync(sb.offtimes);
    assert.equal(ask(sb, `PI.offTimesStatus(${NOW})`).state, "missing");
    put(sb.offtimes, table(90, intervals));
    put(path.join(sb.coord, "shabbos.json"), { enabled: false });
    assert.deepEqual(ask(sb, `[PI.readOffTimes(${NOW}), IO.readOffTimes(${NOW}), PI.offTimesStatus(${NOW}), IO.offTimesStatus(${NOW})]`), [[], [], null, null]);
  } finally { sb.cleanup(); }
});

test("recomputePace passes injected off intervals and defaults to the table", () => {
  const sb = sandbox();
  try {
    const off = [{ start: NOW - DAY, end: NOW + DAY, kind: "shabbat" }];
    const reading = { ts: NOW, pct: 30, resets_at: S(NOW + 120 * MIN), week_pct: 40, week_resets_at: S(NOW + 3 * DAY) };
    put(path.join(sb.coord, "usage", "s-1.json"), reading);
    put(sb.offtimes, table(90, off));
    const expected = P.paceState({ readings: [reading], now: NOW, off }).claude;
    assert.deepEqual(ask(sb, `IO.recomputePace({ now: ${NOW}, write: false }).pace.claude`), expected);
    assert.deepEqual(ask(sb, `IO.recomputePace({ now: ${NOW}, off: ${JSON.stringify(off)}, write: false }).pace.claude`), expected);
    assert.deepEqual(ask(sb, `IO.recomputePace({ now: ${NOW}, off: [], write: false }).pace.claude`), P.paceState({ readings: [reading], now: NOW }).claude);
    assert.equal(fs.existsSync(path.join(sb.coord, "pace.json")), false);
  } finally { sb.cleanup(); }
});

test("one alert at 59 days left", () => {
  const sb = sandbox();
  try {
    put(sb.offtimes, table(61));
    assert.doesNotMatch(tick(sb), /offtimes/);
    assert.equal(alerts(sb).length, 0);
    put(sb.offtimes, table(59));
    assert.match(tick(sb, { dryRun: true }), /would alert: .*59 days left/);
    assert.equal(alerts(sb).length, 0);
    assert.match(tick(sb), /offtimes.json has 59 days left - alert /);
    assert.equal(state(sb).offtimes_alerted, NOW + 59 * DAY);
    assert.deepEqual(alerts(sb).map((a) => a.text), [P.OFFTIMES_EXPIRY_TEXT(P.offStatus(table(59), NOW))]);
    assert.doesNotMatch(tick(sb), /offtimes/);
    assert.equal(alerts(sb).length, 1);
    put(sb.offtimes, table(58));
    assert.match(tick(sb), /offtimes.json has 58 days left - alert /);
    assert.equal(alerts(sb).length, 2);
  } finally { sb.cleanup(); }
});

test("a missing table alerts once a day", () => {
  const sb = sandbox();
  try {
    fs.rmSync(sb.offtimes);
    assert.match(tick(sb, { dryRun: true }), /would alert: .*missing or unreadable/);
    assert.equal(alerts(sb).length, 0);
    assert.match(tick(sb), /offtimes.json is missing - alert /);
    assert.equal(state(sb).offtimes_bad_at, NOW);
    assert.deepEqual(alerts(sb).map((a) => a.text), [P.OFFTIMES_BAD_TEXT("missing")]);
    assert.doesNotMatch(tick(sb), /offtimes/);
    assert.equal(alerts(sb).length, 1);
    const f = path.join(sb.coord, "pause", "tick-state.json");
    put(f, { ...state(sb), offtimes_bad_at: NOW - 25 * 60 * MIN });
    assert.match(tick(sb), /offtimes.json is missing - alert /);
    assert.equal(alerts(sb).length, 2);
    put(f, { ...state(sb), offtimes_bad_at: NOW - 25 * 60 * MIN });
    put(path.join(sb.coord, "shabbos.json"), { enabled: false });
    assert.doesNotMatch(tick(sb), /offtimes/);
    assert.equal(alerts(sb).length, 2);
  } finally { sb.cleanup(); }
});

test("an invalid table alerts daily, and a repo tick raises no table alerts", () => {
  const sb = sandbox();
  try {
    put(sb.offtimes, { ...table(90), tz: "UTC" });
    assert.doesNotMatch(tick(sb, { repoKey: sb.repo }), /offtimes/);
    assert.equal(alerts(sb).length, 0);
    assert.match(tick(sb), /offtimes.json is invalid - alert /);
    assert.deepEqual(alerts(sb).map((a) => a.text), [P.OFFTIMES_BAD_TEXT("invalid")]);
    assert.doesNotMatch(tick(sb), /offtimes/);
    const f = path.join(sb.coord, "pause", "tick-state.json");
    put(f, { ...state(sb), offtimes_bad_at: NOW - DAY });
    assert.match(tick(sb), /offtimes.json is invalid - alert /);
    assert.equal(alerts(sb).length, 2);
  } finally { sb.cleanup(); }
});

test("the sandbox default table raises nothing", () => {
  const sb = sandbox();
  try {
    assert.doesNotMatch(tick(sb), /offtimes/);
    assert.equal(alerts(sb).length, 0);
  } finally { sb.cleanup(); }
});

test("the tick in off-time writes no pace.json", () => {
  const sb = sandbox();
  try {
    put(sb.offtimes, table(90, [{ start: NOW - MIN, end: NOW + MIN, kind: "shabbat" }]));
    sb.env.HL_FAKE_POWER = "10,battery";
    tick(sb);
    for (const f of ["pace.json", "power.json", "pause/battery.json"]) assert.equal(fs.existsSync(path.join(sb.coord, f)), false, f);
    put(path.join(sb.coord, "pace.json"), { updated: NOW - MIN });
    tick(sb);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8")), { updated: NOW - MIN });
    put(path.join(sb.coord, "shabbos.json"), { enabled: false });
    tick(sb);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8")).updated, NOW);
    assert.equal(fs.existsSync(path.join(sb.coord, "power.json")), true);
  } finally { sb.cleanup(); }
});

test("a future bad-table stamp does not suppress the daily alert", () => {
  const sb = sandbox();
  try {
    fs.rmSync(sb.offtimes);
    put(path.join(sb.coord, "pause", "tick-state.json"), { offtimes_bad_at: NOW + MIN });
    assert.match(tick(sb), /offtimes.json is missing - alert /);
    assert.equal(state(sb).offtimes_bad_at, NOW);
    assert.deepEqual(alerts(sb).map((a) => a.text), [P.OFFTIMES_BAD_TEXT("missing")]);
    assert.doesNotMatch(tick(sb), /offtimes/);
    assert.equal(alerts(sb).length, 1);
  } finally { sb.cleanup(); }
});
