// Dev-only calendar calculations. H and all timestamps come from the caller; no imports or clock.
export const TZ = "Asia/Jerusalem";
export const YOM_TOV = [
  ["TISHREI", 1, "rosh-hashana"], ["TISHREI", 2, "rosh-hashana"],
  ["TISHREI", 10, "yom-kippur"], ["TISHREI", 15, "sukkot"], ["TISHREI", 22, "shemini-atzeret"],
  ["NISAN", 15, "pesach"], ["NISAN", 21, "pesach-7"], ["SIVAN", 6, "shavuot"],
];
const DAY = 864e5, HOUR = 36e5;
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

export function tableErrors(table) {
  if (!table || typeof table !== "object" || Array.isArray(table)) return ["table must be an object"];
  const errors = [];
  if (table.tz !== TZ) errors.push(`tz must be ${TZ}`);
  if (!Number.isFinite(table.until)) errors.push("until must be finite epoch ms");
  if (!Array.isArray(table.intervals)) return [...errors, "intervals must be an array"];
  for (let i = 0; i < table.intervals.length; i++) {
    const d = table.intervals[i], prev = table.intervals[i - 1], at = `interval ${i}`;
    if (!d || typeof d !== "object" || Array.isArray(d)) { errors.push(`${at} must be an object`); continue; }
    if (!Number.isFinite(d.start)) errors.push(`${at}: start must be finite epoch ms`);
    if (!Number.isFinite(d.end)) errors.push(`${at}: end must be finite epoch ms`);
    if (Number.isFinite(d.start) && Number.isFinite(d.end)) {
      if (d.start >= d.end) errors.push(`${at}: start must be less than end`);
      const hours = (d.end - d.start) / HOUR;
      if (hours < 20 || hours > 80) errors.push(`${at}: duration must be 20-80 h`);
    }
    if (typeof d.kind !== "string" || !d.kind.trim()) errors.push(`${at}: kind must be non-empty`);
    if (prev && Number.isFinite(d.start)) {
      if (Number.isFinite(prev.start) && d.start < prev.start) errors.push(`${at}: unsorted start`);
      if (Number.isFinite(prev.end) && d.start < prev.end) errors.push(`${at}: overlaps previous interval`);
    }
  }
  return errors;
}

export function buildTable({ intervals, version, license, location, generated, until }) {
  return { source: `@hebcal/core ${version}`, license, tz: TZ, location, generated, until, intervals };
}
