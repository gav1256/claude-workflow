// Batch B, Part 7: the power probes' parsers, HL_FAKE_POWER and the low-battery rule (power.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
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
  assert.deepEqual(W.fakePower("fail"), { failed: true });
  assert.equal(W.fakePower("x"), null);
  assert.equal(W.lowBattery(W.fakePower("19,battery"), 20), true);
  assert.equal(W.lowBattery(W.fakePower("20,battery"), 20), true);
  assert.equal(W.lowBattery(W.fakePower("21,battery"), 20), false);
  assert.equal(W.lowBattery(W.parseWinBattery("19|6"), 20), false);
  assert.equal(W.lowBattery(W.parseWinBattery("19|"), 20), false); // unknown AC: never
  assert.equal(W.lowBattery(W.fakePower("none"), 20), false);
  assert.deepEqual(W.probePower({ HL_FAKE_POWER: "12,battery" }), { battery: true, pct: 12, ac: false });
});

test("I1: failed, non-zero and timed-out platform probes are distinct from successful no-battery readings", (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    for (const os of ["win32", "darwin"]) {
      Object.defineProperty(process, "platform", { ...platform, value: os });
      let result;
      t.mock.method(cp, "spawnSync", (cmd, args, options) => {
        assert.equal(options.timeout, 10000);
        if (os === "win32") {
          assert.equal(options.windowsHide, true);
          assert.match(args.at(-1), /-ErrorAction Stop/);
        }
        if (result instanceof Error) throw result;
        return result;
      });
      syncBuiltinESMExports();
      const stdout = os === "win32" ? "NONE" : "Now drawing from 'AC Power'\n";
      for (result of [{ status: 1, stdout }, { status: null, stdout, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }, { status: 0, stdout, error: new Error("failed") }, { status: 0, stdout: "" }, { status: 0, stdout: "garbage" }, new Error("failed")]) {
        assert.deepEqual(W.probePower({}), { failed: true }, os);
      }
      result = { status: 0, stdout };
      assert.deepEqual(W.probePower({}), W.NO_BATTERY, os);
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    let names = new Error("unreadable directory"), contents = new Error("unreadable supply");
    t.mock.method(fs, "readdirSync", () => { if (names instanceof Error) throw names; return names; });
    t.mock.method(fs, "readFileSync", (file) => {
      if (contents instanceof Error) throw contents;
      if (file.endsWith("type")) return "Battery";
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    assert.deepEqual(W.probePower({}), { failed: true });
    names = Object.assign(new Error("missing directory"), { code: "ENOENT" });
    assert.deepEqual(W.probePower({}), W.NO_BATTERY);
    names = Object.assign(new Error("denied directory"), { code: "EACCES" });
    assert.deepEqual(W.probePower({}), { failed: true });
    names = ["BAT0"];
    assert.deepEqual(W.probePower({}), { failed: true });
    contents = Object.assign(new Error("missing supply"), { code: "ENOENT" });
    assert.deepEqual(W.probePower({}), { failed: true });
    contents = "Battery";
    assert.deepEqual(W.probePower({}), { failed: true });
    names = [];
    assert.deepEqual(W.probePower({}), W.NO_BATTERY);
  } finally {
    Object.defineProperty(process, "platform", platform);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(W.probePower({ HL_FAKE_POWER: "fail" }), { failed: true });
});

test("the fake probe answers in its shape without probing the machine", () => {
  const p = W.probePower({ HL_FAKE_POWER: "19,battery" });
  assert.equal(typeof p.battery, "boolean");
  assert.ok(p.pct === null || (p.pct >= 0 && p.pct <= 100));
  assert.ok(p.ac === null || typeof p.ac === "boolean");
});

test("review fixes: device batteries, unreadable capacity, garbage and explicit fake environments", () => {
  assert.deepEqual(W.parseSysfs([{ type: "Battery", scope: "Device\n", capacity: "15", status: "Discharging" }]), { battery: false, pct: null, ac: null });
  assert.deepEqual(W.parseSysfs([{ type: "Battery", scope: "device", capacity: "15", status: "Discharging" }, { type: "Battery", scope: "System", capacity: "60", status: "Charging" }]), { battery: true, pct: 60, ac: true });
  assert.deepEqual(W.parseSysfs([{ type: "Battery", capacity: "", status: "Discharging" }]), { battery: true, pct: null, ac: false });
  assert.equal(W.lowBattery(W.parseSysfs([{ type: "Battery", capacity: "", status: "Discharging" }]), 20), false);
  assert.equal(W.parseSysfs([{ type: "Battery", capacity: "80", status: "Discharging" }, { type: "Battery", capacity: "", status: "Discharging" }]).pct, 80);
  assert.deepEqual(W.parseWinBattery("hello"), { battery: false, pct: null, ac: null });
  for (const v of ["NONE", " none ", "None"]) assert.deepEqual(W.fakePower(v), { battery: false, pct: null, ac: null });
  assert.deepEqual(W.fakePower(" 19,Battery "), { battery: true, pct: 19, ac: false });
  assert.equal(W.fakePower("150,ac"), null);
  assert.deepEqual(W.probePower({ HL_FAKE_POWER: "none" }), W.fakePower("none"));
  assert.deepEqual(W.probePower({ HL_FAKE_POWER: "80,ac" }), W.fakePower("80,ac"));
});

test("multiple batteries: capacity-weighted charge when all capacities are known, plain mean otherwise", () => {
  assert.equal(W.parseWinBattery("80|1|60000\n20|1|20000").pct, 65);
  for (const cap of ["", "0", "bad"]) assert.equal(W.parseWinBattery(`80|1|60000\n20|1|${cap}`).pct, 50);
  const bats = [{ type: "Battery", capacity: "80", status: "Discharging", energy_full: "60000" }, { type: "Battery", capacity: "20", status: "Discharging", energy_full: "20000" }];
  assert.equal(W.parseSysfs(bats).pct, 65);
  assert.equal(W.parseSysfs(bats.map(({ energy_full, ...b }) => ({ ...b, charge_full: energy_full }))).pct, 65);
  assert.equal(W.parseSysfs([bats[0], { ...bats[1], energy_full: "" }]).pct, 50);
  assert.equal(W.parseSysfs([bats[0], { ...bats[1], energy_full: "0" }]).pct, 50);
  assert.equal(W.parseSysfs([bats[0], { ...bats[1], energy_full: undefined, charge_full: "20000" }]).pct, 50); // unlike units: no weights
});

test("C3: the battery documentation limits probes to system batteries and names excluded Device batteries", () => {
  const doc = fs.readFileSync(new URL("../coordinator.md", import.meta.url), "utf8");
  assert.ok(/system batteries only/.test(doc), "battery docs specify system-only probes");
  assert.ok(/scope=Device[^\n]*mice[^\n]*headsets[^\n]*skipped/.test(doc), "battery docs name excluded peripherals");
});
