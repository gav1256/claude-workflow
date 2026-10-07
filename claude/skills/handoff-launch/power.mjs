// Power probes (batch B, Part 7): user-level only, no admin. -> {battery, pct, ac}: battery false = no battery (a
// desktop): never pauses; ac null = unknown (a null/absent BatteryStatus): never pauses. The parsers are pure; probePower
// runs the platform's probe (spawnSync, hidden, 10 s). HL_FAKE_POWER=<pct>,battery | <pct>,ac | none injects a reading.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const NO_BATTERY = Object.freeze({ battery: false, pct: null, ac: null });
// Win32_Battery BatteryStatus: 1 (other: discharging), 4 (low), 5 (critical) = not on AC; any other value (2 unknown =
// on AC, 3 fully charged, 6-9 charging, 10, 11) = on AC.
const OFF_AC = new Set([1, 4, 5]);
// The Windows probe's output: NONE, or one <EstimatedChargeRemaining>|<BatteryStatus> line per battery. Several
// batteries: the mean charge; on AC unless one of them reports discharging; a battery without a status makes ac unknown.
export function parseWinBattery(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines[0] === "NONE") return { ...NO_BATTERY };
  const rows = lines.map((l) => l.split("|")).map(([p, s]) => ({ pct: p === "" ? NaN : Number(p), status: s === "" || s == null ? NaN : Number(s) }));
  const pcts = rows.map((r) => r.pct).filter(Number.isFinite);
  const ac = rows.some((r) => !Number.isFinite(r.status)) ? null : !rows.some((r) => OFF_AC.has(r.status));
  return { battery: true, pct: pcts.length ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null, ac };
}
// macOS `pmset -g batt`: "Now drawing from 'AC Power'" or "'Battery Power'", then " -InternalBattery-0 ... 79%; ...".
export function parsePmset(text) {
  const t = String(text ?? "");
  const m = /InternalBattery[^\n]*?(\d+)%/.exec(t);
  if (!m) return { ...NO_BATTERY };
  return { battery: true, pct: Number(m[1]), ac: /'AC Power'/.test(t) ? true : /'Battery Power'/.test(t) ? false : null };
}
// Linux /sys/class/power_supply/*: [{type, capacity, status, online}] (strings as read). On AC: a Mains supply online,
// or a battery not discharging.
export function parseSysfs(supplies) {
  const bats = (supplies || []).filter((s) => String(s.type).trim() === "Battery");
  if (!bats.length) return { ...NO_BATTERY };
  const mains = (supplies || []).filter((s) => String(s.type).trim() === "Mains");
  const pcts = bats.map((b) => Number(String(b.capacity ?? "").trim())).filter(Number.isFinite);
  const discharging = bats.some((b) => String(b.status ?? "").trim() === "Discharging");
  const ac = mains.some((s) => String(s.online ?? "").trim() === "1") ? true : discharging ? false : bats.every((b) => String(b.status ?? "").trim() !== "") ? true : null;
  return { battery: true, pct: pcts.length ? Math.round(pcts.reduce((s, x) => s + x, 0) / pcts.length) : null, ac };
}
// HL_FAKE_POWER: "19,battery" (19 %, not on AC), "80,ac", "none" (a desktop). Anything else: null (no fake).
export function fakePower(v) {
  if (v === "none") return { ...NO_BATTERY };
  const m = /^(\d{1,3}),(battery|ac)$/.exec(String(v ?? ""));
  return m ? { battery: true, pct: Number(m[1]), ac: m[2] === "ac" } : null;
}
// Low battery: a battery, not on AC, at or under battery_pct. Unknown AC or charge: never.
export const lowBattery = (p, pct) => !!p?.battery && p.ac === false && Number.isFinite(p.pct) && p.pct <= pct;
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
// The platform probe. A failed probe reads as no battery: it never pauses (fail open).
export function probePower(env = process.env) {
  const fake = fakePower(env.HL_FAKE_POWER);
  if (fake) return fake;
  try {
    if (process.platform === "win32") {
      const ps = "$b=@(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue); if(-not $b.Count){'NONE'} else { $b | ForEach-Object { '{0}|{1}' -f $_.EstimatedChargeRemaining,$_.BatteryStatus } }";
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 10000, windowsHide: true });
      return r.status === 0 ? parseWinBattery(r.stdout) : { ...NO_BATTERY };
    }
    if (process.platform === "darwin") {
      const r = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 10000 });
      return r.status === 0 ? parsePmset(r.stdout) : { ...NO_BATTERY };
    }
    const dir = "/sys/class/power_supply";
    let names = []; try { names = fs.readdirSync(dir); } catch { return { ...NO_BATTERY }; }
    return parseSysfs(names.map((n) => ({ type: read(path.join(dir, n, "type")), capacity: read(path.join(dir, n, "capacity")), status: read(path.join(dir, n, "status")), online: read(path.join(dir, n, "online")) })));
  } catch { return { ...NO_BATTERY }; }
}
