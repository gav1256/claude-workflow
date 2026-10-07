// Batch B, Part 7: the power probes' parsers, HL_FAKE_POWER and the low-battery rule (power.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as W from "../power.mjs";

test("Windows: BatteryStatus 1/4/5 is off AC, every other value on AC (2, 3, the charging states 6-9); none = no battery; no status = unknown", () => {
  assert.deepEqual(W.parseWinBattery("NONE\r\n"), { battery: false, pct: null, ac: null });
  assert.deepEqual(W.parseWinBattery(""), { battery: false, pct: null, ac: null });
  for (const s of [1, 4, 5]) assert.deepEqual(W.parseWinBattery(`19|${s}`), { battery: true, pct: 19, ac: false }, String(s));
  for (const s of [2, 3, 6, 7, 8, 9, 11]) assert.equal(W.parseWinBattery(`19|${s}`).ac, true, String(s));
  assert.deepEqual(W.parseWinBattery("19|"), { battery: true, pct: 19, ac: null });
  assert.deepEqual(W.parseWinBattery("40|2\n20|1"), { battery: true, pct: 30, ac: false }); // two batteries: the mean; one discharging
});

test("macOS pmset and Linux sysfs", () => {
  assert.deepEqual(W.parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t18%; discharging; 0:40 remaining present: true\n"), { battery: true, pct: 18, ac: false });
  assert.deepEqual(W.parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t79%; charging; present: true\n"), { battery: true, pct: 79, ac: true });
  assert.deepEqual(W.parsePmset("Now drawing from 'AC Power'\n"), { battery: false, pct: null, ac: null }); // a desktop Mac
  assert.deepEqual(W.parseSysfs([{ type: "Battery\n", capacity: "17\n", status: "Discharging\n" }, { type: "Mains\n", online: "0\n" }]), { battery: true, pct: 17, ac: false });
  assert.deepEqual(W.parseSysfs([{ type: "Battery", capacity: "17", status: "Charging" }]), { battery: true, pct: 17, ac: true });
  assert.deepEqual(W.parseSysfs([{ type: "Mains", online: "1" }]), { battery: false, pct: null, ac: null });
});

test("HL_FAKE_POWER and the low-battery rule: at or under battery_pct and not on AC; charging at 19 % (status 6) is on AC", () => {
  assert.deepEqual(W.fakePower("19,battery"), { battery: true, pct: 19, ac: false });
  assert.deepEqual(W.fakePower("80,ac"), { battery: true, pct: 80, ac: true });
  assert.deepEqual(W.fakePower("none"), { battery: false, pct: null, ac: null });
  assert.equal(W.fakePower("x"), null);
  assert.equal(W.lowBattery(W.fakePower("19,battery"), 20), true);
  assert.equal(W.lowBattery(W.fakePower("20,battery"), 20), true);
  assert.equal(W.lowBattery(W.fakePower("21,battery"), 20), false);
  assert.equal(W.lowBattery(W.parseWinBattery("19|6"), 20), false);
  assert.equal(W.lowBattery(W.parseWinBattery("19|"), 20), false); // unknown AC: never
  assert.equal(W.lowBattery(W.fakePower("none"), 20), false);
  assert.deepEqual(W.probePower({ HL_FAKE_POWER: "12,battery" }), { battery: true, pct: 12, ac: false });
});

test("the real probe answers in its shape (read-only, hidden)", () => {
  const p = W.probePower({});
  assert.equal(typeof p.battery, "boolean");
  assert.ok(p.pct === null || (p.pct >= 0 && p.pct <= 100));
  assert.ok(p.ac === null || typeof p.ac === "boolean");
});

test("review fixes: device batteries, unreadable capacity, garbage, fake normalisation, null env", () => {
  assert.deepEqual(W.parseSysfs([{ type: "Battery", scope: "Device\n", capacity: "15", status: "Discharging" }]), { battery: false, pct: null, ac: null });
  assert.deepEqual(W.parseSysfs([{ type: "Battery", scope: "device", capacity: "15", status: "Discharging" }, { type: "Battery", scope: "System", capacity: "60", status: "Charging" }]), { battery: true, pct: 60, ac: true });
  assert.deepEqual(W.parseSysfs([{ type: "Battery", capacity: "", status: "Discharging" }]), { battery: true, pct: null, ac: false });
  assert.equal(W.lowBattery(W.parseSysfs([{ type: "Battery", capacity: "", status: "Discharging" }]), 20), false);
  assert.equal(W.parseSysfs([{ type: "Battery", capacity: "80", status: "Discharging" }, { type: "Battery", capacity: "", status: "Discharging" }]).pct, 80);
  assert.deepEqual(W.parseWinBattery("hello"), { battery: false, pct: null, ac: null });
  for (const v of ["NONE", " none ", "None"]) assert.deepEqual(W.fakePower(v), { battery: false, pct: null, ac: null });
  assert.deepEqual(W.fakePower(" 19,Battery "), { battery: true, pct: 19, ac: false });
  assert.equal(W.fakePower("150,ac"), null);
  assert.deepEqual(W.probePower(null), W.probePower({}));
  assert.deepEqual(W.probePower(undefined), W.probePower({}));
});
