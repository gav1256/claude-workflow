// S1a: no calendar dependency; dates, generation time and output paths are all injected.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox } from "./helpers.mjs";
import { writeAtomic } from "../live.mjs";

const lib = () => import("../../../../tools/offtimes-lib.mjs");
const CLI = fileURLToPath(new URL("../../../../tools/gen-offtimes.mjs", import.meta.url));
const UTC = (y, m, d, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));
const HOUR = 3600000, NOW = +UTC(2026, 10, 7, 12);
const YT = { "5787-7-1": [2026, 9, 12], "5787-7-2": [2026, 9, 13], "5787-7-10": [2026, 9, 21], "5787-7-15": [2026, 9, 26], "5787-7-22": [2026, 10, 3] };
const fakeH = {
  months: { TISHREI: 7, NISAN: 1, SIVAN: 3 },
  Location: { lookup: (c) => (c === "Jerusalem" ? { name: c } : null) },
  HDate: class { constructor(a, m, y) { this.k = a instanceof Date ? null : `${y}-${m}-${a}`; } getFullYear() { return 5787; } greg() { const g = YT[this.k]; return g ? new Date(g[0], g[1] - 1, g[2], 12) : new Date(1900, 0, 1); } },
  Zmanim: class { constructor(loc, d) { this.d = d; } sunset() { return UTC(this.d.getFullYear(), this.d.getMonth() + 1, this.d.getDate(), 15, 30); } tzeit() { return UTC(this.d.getFullYear(), this.d.getMonth() + 1, this.d.getDate(), 16, 15); } },
};

test("mergeDays: adjacent days merge, Chol HaMoed keeps them apart, kind labels", async () => {
  const { mergeDays, offDays } = await lib();
  const days = [
    { start: 96 * HOUR, end: 120 * HOUR, label: "shabbat" },
    { start: 0, end: 24 * HOUR, label: "shabbat" },
    { start: 0, end: 24 * HOUR, label: "rosh-hashana" },
    { start: 24 * HOUR, end: 49 * HOUR, label: "rosh-hashana" },
    { start: 144 * HOUR, end: 169 * HOUR, label: "pesach" },
    { start: 192 * HOUR, end: 217 * HOUR, label: "shabbat" },
  ];
  const before = structuredClone(days);
  assert.deepEqual(mergeDays(days), [
    { start: 0, end: 49 * HOUR, kind: "rosh-hashana+shabbat" },
    { start: 96 * HOUR, end: 120 * HOUR, kind: "shabbat" },
    { start: 144 * HOUR, end: 169 * HOUR, kind: "pesach" },
    { start: 192 * HOUR, end: 217 * HOUR, kind: "shabbat" },
  ]);
  assert.deepEqual(days, before);
  assert.deepEqual(mergeDays([{ start: 10, end: 30, label: "shabbat" }, { start: 20, end: 25, label: "pesach" }]), [{ start: 10, end: 30, kind: "shabbat+pesach" }]);
  const merged = mergeDays(offDays(fakeH, { from: 2026, to: 2026 }));
  assert.deepEqual(merged.find((d) => d.start === +UTC(2026, 9, 11, 15, 30)), {
    start: +UTC(2026, 9, 11, 15, 30), end: +UTC(2026, 9, 13, 16, 15), kind: "rosh-hashana+shabbat",
  });
  assert.equal(merged.some((d) => d.start <= +UTC(2026, 9, 27, 12) && d.end > +UTC(2026, 9, 27, 12)), false);
  assert.deepEqual(mergeDays([]), []);
});

test("tableErrors: each broken table is named", async () => {
  const { tableErrors } = await lib();
  const interval = (start = 0, end = 25 * HOUR, kind = "shabbat") => ({ start, end, kind });
  const table = (o = {}) => ({ tz: "Asia/Jerusalem", until: +UTC(2030, 12, 31), intervals: [interval()], ...o });
  assert.deepEqual(tableErrors(table()), []);
  assert.deepEqual(tableErrors(table({ intervals: [] })), []);
  const cases = [
    [table({ tz: "UTC" }), /tz/],
    ...[NaN, Infinity, "2030", undefined].map((until) => [table({ until }), /until/]),
    [table({ intervals: [interval(50 * HOUR, 75 * HOUR), interval()] }), /unsorted/],
    [table({ intervals: [interval(), interval(24 * HOUR, 49 * HOUR)] }), /overlap/],
    [table({ intervals: [interval(1, 1)] }), /start.*end/],
    [table({ intervals: [interval(2, 1)] }), /start.*end/],
    ...[19, 81].map((hours) => [table({ intervals: [interval(0, hours * HOUR)] }), /duration/]),
    ...["", " ", null].map((kind) => [table({ intervals: [interval(0, 25 * HOUR, kind)] }), /kind/]),
    [null, /table/], [table({ intervals: null }), /intervals/],
    [table({ intervals: [null] }), /interval/],
    [table({ intervals: [interval(NaN)] }), /start/],
    [table({ intervals: [interval(0, Infinity)] }), /end/],
  ];
  for (const [t, named] of cases) assert.match(tableErrors(t).join("\n"), named);
  for (const hours of [20, 80]) assert.deepEqual(tableErrors(table({ intervals: [interval(0, hours * HOUR)] })), []);
  assert.deepEqual(tableErrors(table({ intervals: [interval(), interval(25 * HOUR, 50 * HOUR)] })), []);
});

test("offDays with a fake calendar: Saturdays, the Israel Yom Tov list, sunset of the eve to nightfall", async () => {
  const { offDays, YOM_TOV } = await lib();
  assert.deepEqual(YOM_TOV, [["TISHREI", 1, "rosh-hashana"], ["TISHREI", 2, "rosh-hashana"], ["TISHREI", 10, "yom-kippur"], ["TISHREI", 15, "sukkot"], ["TISHREI", 22, "shemini-atzeret"], ["NISAN", 15, "pesach"], ["NISAN", 21, "pesach-7"], ["SIVAN", 6, "shavuot"]]);
  const calls = [], H = { ...fakeH, Zmanim: class extends fakeH.Zmanim {
    constructor(loc, d, il) { super(loc, d); assert.equal(loc.name, "Jerusalem"); assert.equal(il, false); assert.equal(d.getHours(), 12); }
    tzeit(angle) { calls.push(angle); return super.tzeit(); }
  } };
  const days = offDays(H, { from: 2026, to: 2026 });
  const saturdays = days.filter((d) => d.label === "shabbat");
  assert.equal(saturdays.length, 52);
  assert.equal(saturdays[0].date, "2026-01-03"); assert.equal(saturdays.at(-1).date, "2026-12-26");
  for (const d of saturdays) assert.equal(new Date(`${d.date}T12:00:00Z`).getUTCDay(), 6);
  assert.deepEqual(days.filter((d) => d.label !== "shabbat").map((d) => [d.date, d.label]), [
    ["2026-09-12", "rosh-hashana"], ["2026-09-13", "rosh-hashana"], ["2026-09-21", "yom-kippur"], ["2026-09-26", "sukkot"], ["2026-10-03", "shemini-atzeret"],
  ]);
  for (const d of days) {
    const ms = Date.parse(`${d.date}T00:00:00Z`);
    assert.equal(d.start, ms - 864e5 + 15.5 * HOUR); assert.equal(d.end, ms + 16.25 * HOUR);
  }
  assert.equal(calls.length, days.length); assert.ok(calls.every((angle) => angle === 8.5));
  const all = { ...YT, "5787-1-15": [2026, 4, 2], "5787-1-21": [2026, 4, 8], "5787-3-6": [2026, 5, 22] };
  const full = { ...fakeH, HDate: class extends fakeH.HDate { greg() { const g = all[this.k]; return g ? new Date(g[0], g[1] - 1, g[2], 12) : super.greg(); } } };
  assert.equal(offDays(full, { from: 2026, to: 2026 }).filter((d) => d.label !== "shabbat").length, 8);
  assert.throws(() => offDays(fakeH, { from: 2026, to: 2026, city: "Unknown" }), /unknown city/);
});

const USAGE = "usage: node tools/gen-offtimes.mjs --hebcal <dir> --from <year> --to <year> [--city <name>] [--out <file>]";
test("gen-offtimes: no --hebcal is a usage error", () => {
  const r = spawnSync(process.execPath, [CLI, "--from", "2026", "--to", "2030"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(r.status, 2, r.stderr); assert.equal(r.stderr.trim(), USAGE); assert.equal(r.stdout, "");
});

async function run(args) {
  const { main } = await import("../../../../tools/gen-offtimes.mjs");
  let out = "", err = "";
  const code = await main(args, { now: () => NOW, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return { code, out, err };
}

function calendarPackage(sb, { module = false, complete = true, invalid = false } = {}) {
  const dir = path.join(sb.tmp, module ? "fake module calendar" : "fake calendar"), entry = "calendar.mjs";
  const dates = { ...YT, "5788-7-1": [2027, 9, 20] };
  if (complete) Object.assign(dates, { "5787-1-15": [2027, 4, 2], "5787-1-21": [2027, 4, 8], "5787-3-6": [2027, 5, 22] });
  writeAtomic(path.join(dir, "package.json"), JSON.stringify({ version: "0.0.0-test", license: "GPL-2.0", ...(module ? { module: entry } : { exports: { ".": { import: entry } }, module: "missing.mjs" }) }));
  writeAtomic(path.join(dir, entry), [
    `const UTC = ${UTC.toString()}; const YT = ${JSON.stringify(dates)};`,
    `export const months = ${JSON.stringify(fakeH.months)};`,
    `export const Location = { lookup: ${fakeH.Location.lookup.toString()} };`,
    `export const HDate = ${fakeH.HDate.toString()};`,
    `export const Zmanim = ${fakeH.Zmanim.toString()};`,
    invalid ? "Zmanim.prototype.tzeit = function() { return new Date(NaN); };" : "",
  ].join("\n"));
  return dir;
}

test("gen-offtimes: bad arguments are usage errors", async () => {
  const good = ["--hebcal", "fake", "--from", "2026", "--to", "2030"];
  for (const args of [[], good.slice(0, 4), [...good, "--other", "x"], [...good, "--city"], [...good, "--out", "--city", "Jerusalem"], [...good, "--from", "2027"], ["--hebcal", "fake", "--from", "2030", "--to", "2026"], ["--hebcal", "fake", "--from", "2e3", "--to", "2030"]]) {
    const r = await run(args); assert.equal(r.code, 2); assert.equal(r.err.trim(), USAGE); assert.equal(r.out, "");
  }
});

test("buildTable and gen-offtimes: metadata, module entries, injected time and atomic output", async () => {
  const { buildTable, tableErrors, offDays, mergeDays } = await lib();
  const intervals = mergeDays(offDays(fakeH, { from: 2026, to: 2026 })), until = +UTC(2026, 12, 31);
  assert.deepEqual(buildTable({ intervals, version: "0.0.0-test", license: "GPL-2.0", location: "Jerusalem", generated: NOW, until }), {
    source: "@hebcal/core 0.0.0-test", license: "GPL-2.0", tz: "Asia/Jerusalem", location: "Jerusalem", generated: NOW, until, intervals,
  });
  const sb = sandbox();
  try {
    for (const module of [false, true]) {
      const dir = calendarPackage(sb, { module }), args = ["--hebcal", dir, "--from", "2026", "--to", "2027", "--city", "Jerusalem"];
      // Distinct package paths avoid ESM caching between the entry-point variants.
      const r = await run(args); assert.equal(r.code, 0, r.err);
      const table = JSON.parse(r.out); assert.deepEqual(tableErrors(table), []);
      assert.equal(table.generated, NOW); assert.equal(table.until, +UTC(2027, 12, 31));
      assert.equal(table.source, "@hebcal/core 0.0.0-test"); assert.equal(table.license, "GPL-2.0"); assert.equal(table.location, "Jerusalem");
      const out = path.join(sb.tmp, "output", "offtimes.json");
      writeAtomic(out, "old");
      const written = await run([...args, "--out", out]); assert.equal(written.code, 0, written.err); assert.equal(written.out, "");
      assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), table);
      assert.deepEqual(fs.readdirSync(path.dirname(out)), ["offtimes.json"]);
    }
  } finally { sb.cleanup(); }
});

test("gen-offtimes: incomplete Hebrew years and invalid tables fail before writing", async () => {
  for (const options of [{ complete: false }, { invalid: true }]) {
    const sb = sandbox();
    try {
      const dir = calendarPackage(sb, options), out = path.join(sb.tmp, "offtimes.json");
      writeAtomic(out, "old");
      const r = await run(["--hebcal", dir, "--from", "2026", "--to", "2027", "--out", out]);
      assert.equal(r.code, 1); assert.match(r.err, options.invalid ? /end/ : /5787.*Yom Tov/);
      assert.equal(r.out, ""); assert.equal(fs.readFileSync(out, "utf8"), "old");
    } finally { sb.cleanup(); }
  }
});

test("yearErrors: complete years require all eight Yom Tov dates; partial years are skipped", async () => {
  const { yearErrors } = await import("../../../../tools/gen-offtimes.mjs");
  const { YOM_TOV } = await lib();
  const H = {
    months: { TISHREI: 7, NISAN: 1, SIVAN: 3 },
    HDate: class {
      constructor(d, m, y) { this.d = d; this.m = m; this.y = y; }
      getFullYear() { return this.d.getFullYear(); }
      greg() {
        return new Date(this.y + (this.m === 7 ? 0 : 1), this.m === 7 ? 8 : this.m === 1 ? 3 : 5, this.d, 12);
      }
    },
  };
  const days = YOM_TOV.map(([m, d, label]) => {
    const g = new H.HDate(d, H.months[m], 2026).greg();
    return { date: new Date(Date.UTC(g.getFullYear(), g.getMonth(), g.getDate())).toISOString().slice(0, 10), label };
  });
  const before = structuredClone(days), opts = { from: 2026, to: 2027 };
  assert.deepEqual(yearErrors(H, days, opts), []);
  for (let i = 0; i < days.length; i++) {
    assert.deepEqual(yearErrors(H, days.filter((_, n) => n !== i), opts),
      ["Hebrew year 2026: missing Yom Tov dates (expected all 8)"]);
  }
  assert.deepEqual(yearErrors(H, [], { from: 2026, to: 2026 }), []);
  assert.deepEqual(days, before);
});
