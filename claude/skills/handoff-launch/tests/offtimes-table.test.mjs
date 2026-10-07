// S1b: checks the committed, generated off-time table (no calendar library needed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const T = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "offtimes.json"), "utf8"));
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(ms).map((p) => [p.type, p.value]));
const dateOf = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; }, hourOf = (ms) => Number(parts(ms).hour);
const noon = (d) => Date.parse(`${d}T09:30:00Z`); // late morning in Jerusalem, winter or summer
const cover = (ms) => T.intervals.find((o) => o.start <= ms && ms < o.end);
const LABELS = ["shabbat", "rosh-hashana", "yom-kippur", "sukkot", "shemini-atzeret", "pesach", "pesach-7", "shavuot"];
test("offtimes.json: sorted, merged, every Friday-sunset interval of 2026-2030, the Israel Yom Tov list, kind labels", () => {
  assert.match(T.source, /^@hebcal\/core \d+\.\d+\.\d+$/); assert.equal(T.tz, "Asia/Jerusalem"); assert.equal(T.location, "Jerusalem"); assert.ok(T.until >= Date.UTC(2030, 11, 31));
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
