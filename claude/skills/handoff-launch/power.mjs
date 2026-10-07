// Power probes (batch B, Part 7): user-level only, no admin. -> {battery, pct, ac}: battery false = no battery (a
// desktop): never pauses; ac null = unknown (a null/absent BatteryStatus): never pauses. The parsers are pure; probePower
// runs the platform's probe (spawnSync, hidden, 10 s); failures return {failed:true}, distinct from no battery.
// HL_FAKE_POWER=<pct>,battery | <pct>,ac | none | fail injects a reading or failure.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const NO_BATTERY = Object.freeze({ battery: false, pct: null, ac: null });
// Win32_Battery BatteryStatus: 1 (other: discharging), 4 (low), 5 (critical) = not on AC; any other value (2 unknown =
// on AC, 3 fully charged, 6-9 charging, 10, 11) = on AC.
const OFF_AC = new Set([1, 4, 5]);
const number = (v) => String(v ?? "").trim() === "" ? NaN : Number(v);
// All readable charges need positive capacities in the same unit; otherwise retain the plain mean.
function meanCharge(rows) {
  const valid = rows.filter((r) => Number.isFinite(r.pct));
  if (!valid.length) return null;
  const weighted = valid.every((r) => Number.isFinite(r.weight) && r.weight > 0);
  const total = valid.reduce((s, r) => s + (weighted ? r.weight : 1), 0);
  return Math.round(valid.reduce((s, r) => s + r.pct * (weighted ? r.weight : 1), 0) / total);
}
// The Windows probe's output: NONE, or <EstimatedChargeRemaining>|<BatteryStatus>|<FullChargeCapacity> per battery.
// Capacity-weighted charge when known, plain mean otherwise; any discharging battery is off AC, missing status unknown.
export function parseWinBattery(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines[0] === "NONE") return { ...NO_BATTERY };
  const rows = lines.map((l) => l.split("|")).map(([p, s, w]) => ({ pct: number(p), status: number(s), weight: number(w) }));
  if (!rows.some((r) => Number.isFinite(r.pct) || Number.isFinite(r.status))) return { ...NO_BATTERY }; // garbage, not a reading
  const ac = rows.some((r) => !Number.isFinite(r.status)) ? null : !rows.some((r) => OFF_AC.has(r.status));
  return { battery: true, pct: meanCharge(rows), ac };
}
// macOS `pmset -g batt`: "Now drawing from 'AC Power'" or "'Battery Power'", then " -InternalBattery-0 ... 79%; ...".
export function parsePmset(text) {
  const t = String(text ?? "");
  const m = /InternalBattery[^\n]*?(\d+)%/.exec(t);
  if (!m) return { ...NO_BATTERY };
  return { battery: true, pct: Number(m[1]), ac: /'AC Power'/.test(t) ? true : /'Battery Power'/.test(t) ? false : null };
}
// Linux /sys/class/power_supply/*: [{type, capacity, energy_full, charge_full, scope, status, online}] (strings as read).
// Weights use energy_full, else charge_full when every battery has it (never mix units). On AC: a Mains supply online,
// or a battery not discharging.
export function parseSysfs(supplies) {
  // A device battery (scope "Device": a Bluetooth/HID mouse or keyboard) is not the system battery.
  const bats = (supplies || []).filter((s) => String(s.type).trim() === "Battery" && String(s.scope ?? "").trim().toLowerCase() !== "device");
  if (!bats.length) return { ...NO_BATTERY };
  const mains = (supplies || []).filter((s) => String(s.type).trim() === "Mains");
  const unit = ["energy_full", "charge_full"].find((k) => bats.every((b) => number(b[k]) > 0));
  const rows = bats.map((b) => ({ pct: number(b.capacity), weight: unit ? number(b[unit]) : NaN }));
  const discharging = bats.some((b) => String(b.status ?? "").trim() === "Discharging");
  const ac = mains.some((s) => String(s.online ?? "").trim() === "1") ? true : discharging ? false : bats.every((b) => String(b.status ?? "").trim() !== "") ? true : null;
  return { battery: true, pct: meanCharge(rows), ac };
}
// HL_FAKE_POWER: "19,battery" (19 %, not on AC), "80,ac", "none" (a desktop), "fail". Anything else: null (no fake).
export function fakePower(v) {
  const t = String(v ?? "").trim().toLowerCase();
  if (t === "none") return { ...NO_BATTERY };
  if (t === "fail") return { failed: true };
  const m = /^(\d{1,3}),(battery|ac)$/.exec(t);
  return m && Number(m[1]) <= 100 ? { battery: true, pct: Number(m[1]), ac: m[2] === "ac" } : null;
}
// Low battery: a battery, not on AC, at or under battery_pct. Unknown AC or charge: never.
export const lowBattery = (p, pct) => !!p?.battery && p.ac === false && Number.isFinite(p.pct) && p.pct <= pct;
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch (e) { if (e.code === "ENOENT") return ""; throw e; } };
// The platform probe. A failure or timeout leaves the battery source unchanged; only a successful probe says NONE.
export function probePower(env = process.env) {
  const fake = fakePower((env ?? {}).HL_FAKE_POWER);
  if (fake) return fake;
  try {
    if (process.platform === "win32") {
      const ps = "$b=@(Get-CimInstance Win32_Battery -ErrorAction Stop); if(-not $b.Count){'NONE'} else { $b | ForEach-Object { '{0}|{1}|{2}' -f $_.EstimatedChargeRemaining,$_.BatteryStatus,$_.FullChargeCapacity } }";
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 10000, windowsHide: true });
      if (r.error || r.status !== 0) return { failed: true };
      const p = parseWinBattery(r.stdout);
      return !p.battery && String(r.stdout ?? "").trim() !== "NONE" ? { failed: true } : p;
    }
    if (process.platform === "darwin") {
      const r = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 10000 });
      if (r.error || r.status !== 0) return { failed: true };
      const p = parsePmset(r.stdout);
      return !p.battery && (!/Now drawing from 'AC Power'/.test(r.stdout) || /InternalBattery/.test(r.stdout)) ? { failed: true } : p;
    }
    const dir = "/sys/class/power_supply";
    let names;
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code === "ENOENT") return { ...NO_BATTERY }; throw e; }
    return parseSysfs(names.map((n) => ({ type: fs.readFileSync(path.join(dir, n, "type"), "utf8"), capacity: read(path.join(dir, n, "capacity")), energy_full: read(path.join(dir, n, "energy_full")), charge_full: read(path.join(dir, n, "charge_full")), scope: read(path.join(dir, n, "scope")), status: read(path.join(dir, n, "status")), online: read(path.join(dir, n, "online")) })));
  } catch { return { failed: true }; }
}
