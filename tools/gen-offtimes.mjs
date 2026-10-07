// Dev-only: load an externally installed calendar by path, never a repo dependency.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeAtomic } from "../claude/skills/handoff-launch/live.mjs";
import { YOM_TOV, offDays, mergeDays, buildTable, tableErrors } from "./offtimes-lib.mjs";

const USAGE = "usage: node tools/gen-offtimes.mjs --hebcal <dir> --from <year> --to <year> [--city <name>] [--out <file>]";
function parseArgs(args) {
  const opts = {}, keys = ["hebcal", "from", "to", "city", "out"];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2), value = args[i + 1];
    if (args[i] !== `--${key}` || !keys.includes(key) || key in opts || !value || value.startsWith("--")) return null;
    opts[key] = value;
  }
  if (!opts.hebcal || !/^\d{4}$/.test(opts.from || "") || !/^\d{4}$/.test(opts.to || "")) return null;
  opts.from = Number(opts.from); opts.to = Number(opts.to);
  if (opts.from < 1000 || opts.from > opts.to) return null;
  return { city: "Jerusalem", ...opts };
}

function yearErrors(H, days, { from, to }) {
  const first = Date.UTC(from, 0, 1), after = Date.UTC(to + 1, 0, 1), errors = [];
  const hy0 = new H.HDate(new Date(from, 0, 1, 12)).getFullYear(), hy1 = new H.HDate(new Date(to, 11, 31, 12)).getFullYear();
  const gregMs = (d, month, hy) => { const g = new H.HDate(d, H.months[month], hy).greg(); return Date.UTC(g.getFullYear(), g.getMonth(), g.getDate()); };
  const found = new Set(days.map((d) => `${d.date}:${d.label}`));
  for (let hy = hy0; hy <= hy1; hy++) {
    const start = gregMs(1, "TISHREI", hy), end = gregMs(1, "TISHREI", hy + 1);
    if (!(start >= first && end > start && end <= after)) continue;
    const complete = YOM_TOV.every(([m, d, label]) => {
      const ms = gregMs(d, m, hy);
      return ms >= start && ms < end && found.has(`${new Date(ms).toISOString().slice(0, 10)}:${label}`);
    });
    if (!complete) errors.push(`Hebrew year ${hy}: missing Yom Tov dates (expected all 8)`);
  }
  return errors;
}

export async function main(args, { now = Date.now, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s) } = {}) {
  const opts = parseArgs(args);
  if (!opts) { stderr(`${USAGE}\n`); return 2; }
  try {
    const dir = path.resolve(opts.hebcal), pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const entry = pkg.exports?.["."]?.import || pkg.module;
    if (typeof entry !== "string" || !entry || typeof pkg.version !== "string" || !pkg.version || typeof pkg.license !== "string" || !pkg.license) throw new Error("calendar package needs version, license and an import or module entry");
    const H = await import(pathToFileURL(path.join(dir, entry)).href);
    const days = offDays(H, opts), table = buildTable({ intervals: mergeDays(days), version: pkg.version, license: pkg.license,
      location: opts.city, generated: now(), until: Date.UTC(opts.to, 11, 31) });
    const errors = [...tableErrors(table), ...yearErrors(H, days, opts)];
    if (errors.length) { stderr(`${errors.join("\n")}\n`); return 1; }
    const json = `${JSON.stringify(table, null, 2)}\n`;
    if (opts.out) writeAtomic(path.resolve(opts.out), json);
    else stdout(json);
    return 0;
  } catch (err) { stderr(`${err.message}\n`); return 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
