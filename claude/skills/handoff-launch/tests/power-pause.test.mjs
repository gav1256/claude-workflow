// Batch B, Part 7 wired in: `coord.mjs power`, the battery pause source, the cache and its refresh by hooks and the tick.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { sandbox, coordRun, sessionLine, setAgents, COORD_MJS } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const MIN = 60000;
const battery = (sb) => path.join(sb.coord, "pause", "battery.json");
const power = (sb) => path.join(sb.coord, "power.json");
const putPower = (sb, o, minAgo) => { fs.mkdirSync(sb.coord, { recursive: true }); fs.writeFileSync(power(sb), JSON.stringify({ at: new Date(Date.now() - minAgo * MIN).toISOString(), ...o })); };
const powerEval = (sb, code, env = {}) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import fs from "node:fs"; const PI = await import(${JSON.stringify(new URL("../pause-io.mjs", import.meta.url).href)}); ${code}`],
    { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("coord.mjs power --refresh: low battery writes the battery source, AC or a desktop removes it; plain power writes nothing", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["power"], { env: { HL_FAKE_POWER: "19,battery" } });
    assert.equal(r.out, "power: battery 19% on battery\n");
    assert.equal(fs.existsSync(power(sb)), false);
    r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "19,battery" } });
    assert.equal(r.out, "power: battery 19% on battery - low: every lane pauses\n");
    assert.deepEqual([JSON.parse(fs.readFileSync(battery(sb), "utf8")).pct, JSON.parse(fs.readFileSync(power(sb), "utf8")).ac], [19, false]);
    const since = JSON.parse(fs.readFileSync(battery(sb), "utf8")).since;
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "18,battery" } });
    assert.equal(JSON.parse(fs.readFileSync(battery(sb), "utf8")).since, since); // still the same low-battery spell
    r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "19,ac" } }); // charging at 19 %: on AC
    assert.equal(r.out, "power: battery 19% on AC\n");
    assert.equal(fs.existsSync(battery(sb)), false);
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "5,battery" } });
    r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "none" } });
    assert.equal(r.out, "power: no battery (never pauses)\n");
    assert.equal(fs.existsSync(battery(sb)), false);
    fs.writeFileSync(path.join(sb.coord, "config.json"), JSON.stringify({ battery_pct: 30 }));
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "25,battery" } });
    assert.equal(fs.existsSync(battery(sb)), true); // battery_pct from config.json
  } finally { sb.cleanup(); }
});

test("the battery and manual sources never share a file: refreshes and pause commands at once leave both whole", async () => {
  const sb = sandbox();
  try {
    const run = (args, env = {}) => new Promise((done) => spawn(process.execPath, [COORD_MJS, ...args], { env: { ...sb.env, ...env }, windowsHide: true, stdio: "ignore" }).on("exit", done));
    await Promise.all([...[[], ["30m"], ["2h"], ["5m"]].map((a) => run(["pause", ...a])), ...[1, 2, 3, 4].map(() => run(["power", "--refresh"], { HL_FAKE_POWER: "12,battery" }))]);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "manual.json"), "utf8"))).sort(), ["at", "by", "until"]);
    assert.equal(JSON.parse(fs.readFileSync(battery(sb), "utf8")).pct, 12);
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause")).filter((f) => f.endsWith(".tmp")), []);
  } finally { sb.cleanup(); }
});

test("battery source: every lane and hand-opened session is paused while it is fresh; one not refreshed for 10 min is off", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "H", id: "H@1", effort: "xhigh", sid: "h-s1", supersedes: null });
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "15,battery" } });
    const gate = (env) => coordRun(sb, ["agent-gate"], { input: { session_id: "h-s1", tool_name: "Agent", tool_input: {} }, env });
    assert.equal(JSON.parse(gate({ HL_SESSION_ID: "H@1" }).out).hookSpecificOutput.permissionDecisionReason, PAUSE_TEXT("battery 15%"));
    assert.equal(JSON.parse(gate({}).out).hookSpecificOutput.permissionDecisionReason, PAUSE_TEXT("battery 15%"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "seen", "h-s1.json"), "utf8")).reason, "battery 15%");
    fs.writeFileSync(battery(sb), JSON.stringify({ at: new Date(Date.now() - 11 * MIN).toISOString(), pct: 15, ac: false }));
    putPower(sb, { battery: true, pct: 15, ac: false }, 0); // a fresh cache: the gate triggers no refresh
    assert.equal(gate({ HL_SESSION_ID: "H@1" }).out, "");
  } finally { sb.cleanup(); }
});

test("M5: hooks claim a stale cache refresh about once a minute; a successful no-battery reading lasts an hour", () => {
  const sb = sandbox();
  try {
    const claim = path.join(sb.coord, "power-claim.json"), gate = () => coordRun(sb, ["agent-gate"], { input: { session_id: "s1", tool_name: "Agent", tool_input: {} } });
    putPower(sb, { battery: true, pct: 80, ac: true }, 0.5);
    gate(); assert.equal(fs.existsSync(claim), false); // fresh
    putPower(sb, { battery: true, pct: 80, ac: true }, 2);
    gate(); assert.equal(JSON.parse(fs.readFileSync(claim, "utf8")).by, "agent-gate"); // HL_NO_SPAWN: claimed, not started
    const at = fs.readFileSync(claim, "utf8");
    gate(); assert.equal(fs.readFileSync(claim, "utf8"), at); // claimed under a minute ago
    fs.writeFileSync(claim, JSON.stringify({ at: new Date(Date.now() - 2 * MIN).toISOString(), by: "old" }));
    gate(); assert.equal(JSON.parse(fs.readFileSync(claim, "utf8")).by, "agent-gate"); // claims again after a minute
    fs.rmSync(claim);
    putPower(sb, { battery: false, pct: null, ac: null }, 30);
    gate(); assert.equal(fs.existsSync(claim), false); // a desktop: an hour
  } finally { sb.cleanup(); }
});

test("I1: failed refreshes preserve the battery source, retry after 60 s and fail open only after 10 min", () => {
  const sb = sandbox();
  try {
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "15,battery" } });
    const before = fs.readFileSync(battery(sb), "utf8");
    const r = coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "fail" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "power: probe failed (battery state unchanged)\n");
    assert.equal(fs.readFileSync(battery(sb), "utf8"), before);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(power(sb), "utf8"))).sort(), ["at", "failed"]);
    const result = powerEval(sb, `
      const now = Date.parse(JSON.parse(fs.readFileSync(PI.POWER, "utf8")).at);
      const stale = [PI.powerStale(now + 59000), PI.powerStale(now + 60000)];
      const active = PI.readSources(now + 9 * 60000).some(s => s.source === "battery");
      const expired = PI.readSources(now + 11 * 60000).some(s => s.source === "battery");
      const refreshed = PI.refreshPower(now + 11 * 60000);
      console.log(JSON.stringify({ stale, active, expired, refreshed }));`, { HL_FAKE_POWER: "fail" });
    assert.deepEqual(result, { stale: [false, true], active: true, expired: false, refreshed: { power: { failed: true }, low: false, changed: false } });
    assert.equal(fs.readFileSync(battery(sb), "utf8"), before);
    putPower(sb, { battery: false, failed: true }, 2);
    coordRun(sb, ["agent-gate"], { input: { session_id: "failed-s1", tool_name: "Agent", tool_input: {} } });
    assert.equal(fs.existsSync(path.join(sb.coord, "power-claim.json")), true); // failure never gets an hour
    const empty = sandbox();
    try {
      const failed = coordRun(empty, ["power", "--refresh"], { env: { HL_FAKE_POWER: "fail" } });
      assert.equal(failed.code, 0, failed.err);
      assert.equal(fs.existsSync(battery(empty)), false);
    } finally { empty.cleanup(); }
  } finally { sb.cleanup(); }
});

test("M1: low battery after a source ages out starts a new spell and reports changed", () => {
  const sb = sandbox();
  try {
    const result = powerEval(sb, `
      const now = Date.now(), at = new Date(now).toISOString();
      fs.mkdirSync(PI.PAUSE_DIR, { recursive: true });
      fs.writeFileSync(PI.BATTERY, JSON.stringify({ at: new Date(now - 11 * 60000).toISOString(), since: new Date(now - 60 * 60000).toISOString(), pct: 15, ac: false }));
      const first = PI.refreshPower(now), source = JSON.parse(fs.readFileSync(PI.BATTERY, "utf8"));
      const next = PI.refreshPower(now + 60000), continued = JSON.parse(fs.readFileSync(PI.BATTERY, "utf8"));
      console.log(JSON.stringify({ first, source, next, continued, at }));`, { HL_FAKE_POWER: "15,battery" });
    assert.equal(result.first.changed, true);
    assert.equal(result.source.since, result.at);
    assert.equal(result.source.at, result.at);
    assert.equal(result.next.changed, false);
    assert.equal(result.continued.since, result.at);
  } finally { sb.cleanup(); }
});

test("M2: an older refresh cannot overwrite a newer power reading or battery source, or remove its pause", () => {
  const sb = sandbox();
  try {
    const result = powerEval(sb, `
      const now = Date.now();
      PI.refreshPower(now);
      const power = fs.readFileSync(PI.POWER, "utf8"), battery = fs.readFileSync(PI.BATTERY, "utf8");
      process.env.HL_FAKE_POWER = "18,battery";
      const oldLow = PI.refreshPower(now - 59000);
      process.env.HL_FAKE_POWER = "none";
      const oldNone = PI.refreshPower(now - 59000);
      const preserved = fs.readFileSync(PI.POWER, "utf8") === power && fs.readFileSync(PI.BATTERY, "utf8") === battery;
      fs.rmSync(PI.POWER);
      const batteryOnly = PI.refreshPower(now - 59000);
      console.log(JSON.stringify({ oldLow, oldNone, preserved, batteryOnly, noPower: !fs.existsSync(PI.POWER), sameBattery: fs.readFileSync(PI.BATTERY, "utf8") === battery }));`, { HL_FAKE_POWER: "15,battery" });
    assert.equal(result.oldLow.changed, false);
    assert.equal(result.oldNone.changed, false);
    assert.equal(result.preserved, true);
    assert.equal(result.batteryOnly.changed, false);
    assert.equal(result.noPower, true);
    assert.equal(result.sameBattery, true);
  } finally { sb.cleanup(); }
});

test("N1: power and battery timestamps an hour ahead are overwritten by a fresh low reading that pauses", () => {
  const sb = sandbox();
  try {
    const results = powerEval(sb, `
      const now = Date.now(), at = new Date(now).toISOString(), results = [];
      fs.mkdirSync(PI.PAUSE_DIR, { recursive: true });
      for (const files of [[PI.POWER], [PI.BATTERY], [PI.POWER, PI.BATTERY]]) {
        for (const ahead of [0, 59999, 60000, 3600000]) {
          for (const file of [PI.POWER, PI.BATTERY]) fs.rmSync(file, { force: true });
          const future = new Date(now + ahead).toISOString();
          for (const file of files) fs.writeFileSync(file, JSON.stringify({ at: future, since: future, battery: true, pct: 80, ac: true }));
          const refreshed = PI.refreshPower(now);
          results.push({ ahead, refreshed, power: fs.existsSync(PI.POWER) ? JSON.parse(fs.readFileSync(PI.POWER, "utf8")) : null,
            battery: fs.existsSync(PI.BATTERY) ? JSON.parse(fs.readFileSync(PI.BATTERY, "utf8")) : null,
            paused: PI.readSources(now).some(s => s.source === "battery"), at });
        }
      }
      console.log(JSON.stringify(results));`, { HL_FAKE_POWER: "15,battery" });
    for (const r of results) {
      if (r.ahead === 59999) {
        assert.equal(r.refreshed.changed, false);
        assert.equal((r.power ?? r.battery).pct, 80);
      } else {
        assert.equal(r.power.at, r.at);
        assert.equal(r.power.pct, 15);
        assert.equal(r.battery.at, r.at);
        assert.equal(r.battery.since, r.at);
        assert.equal(r.battery.pct, 15);
        assert.equal(r.paused, true);
        if (r.ahead >= 60000) assert.equal(r.refreshed.changed, true);
      }
    }
  } finally { sb.cleanup(); }
});

test("N2: a missing Linux power_supply directory clears the battery source and caches no battery for an hour", () => {
  const sb = sandbox();
  try {
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "15,battery" } });
    const result = powerEval(sb, `
      const platform = Object.getOwnPropertyDescriptor(process, "platform"), readdir = fs.readdirSync;
      Object.defineProperty(process, "platform", { ...platform, value: "linux" });
      fs.readdirSync = (dir) => {
        if (dir !== "/sys/class/power_supply") throw new Error("unexpected directory");
        throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
      };
      try {
        const now = Date.now(), refreshed = PI.refreshPower(now);
        console.log(JSON.stringify({ refreshed, cached: JSON.parse(fs.readFileSync(PI.POWER, "utf8")),
          battery: fs.existsSync(PI.BATTERY), stale: [PI.powerStale(now + 3599999), PI.powerStale(now + 3600000)] }));
      } finally { fs.readdirSync = readdir; Object.defineProperty(process, "platform", platform); }`, { HL_FAKE_POWER: "" });
    assert.deepEqual(result.refreshed, { power: { battery: false, pct: null, ac: null }, low: false, changed: true });
    assert.deepEqual(result.cached, { at: result.cached.at, battery: false, pct: null, ac: null });
    assert.equal(result.battery, false);
    assert.deepEqual(result.stale, [false, true]);
  } finally { sb.cleanup(); }
});

test("M4: watcher steps retain successful no-battery readings for an hour, but retry failures after a minute", () => {
  const sb = sandbox();
  try {
    coordRun(sb, ["power", "--refresh"], { env: { HL_FAKE_POWER: "none" } });
    const before = fs.readFileSync(power(sb), "utf8");
    let r = coordRun(sb, ["watch", "--once"], { env: { HL_FAKE_POWER: "15,battery" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(power(sb), "utf8"), before);
    assert.equal(fs.existsSync(battery(sb)), false);
    putPower(sb, { battery: false, pct: null, ac: null }, 61);
    r = coordRun(sb, ["watch", "--once"], { env: { HL_FAKE_POWER: "15,battery" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(battery(sb), "utf8")).pct, 15);
    putPower(sb, { failed: true }, 2);
    r = coordRun(sb, ["watch", "--once"], { env: { HL_FAKE_POWER: "90,ac" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(battery(sb)), false);
    assert.equal(JSON.parse(fs.readFileSync(power(sb), "utf8")).ac, true);
  } finally { sb.cleanup(); }
});

test("M5: power documentation describes approximate claims and failed probes aging out", () => {
  const doc = fs.readFileSync(new URL("../coordinator.md", import.meta.url), "utf8");
  assert.match(doc, /claim a refresh about\s+once a minute; concurrent hooks can both claim it/);
  assert.match(doc, /A failed probe changes nothing in the battery source, which fails open after 10 min/);
});

test("the tick refreshes a stale cache: low battery pauses (one line, the watcher starts over an open lane), AC back ends it", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "R", id: "R@1", sid: "r-s1", mode: "bg", bg_id: "bg-R", supersedes: null });
    setAgents(sb, [{ id: "bg-R", sessionId: "r-s1", name: "R", status: "running" }]);
    let r = coordRun(sb, ["tick"], { env: { HL_FAKE_POWER: "15,battery" } });
    assert.match(r.out, /^power: battery 15% on battery - low battery: every lane pauses$/m);
    assert.match(r.out, /^watcher started \(a pause is active\)$/m);
    r = coordRun(sb, ["tick"], { env: { HL_FAKE_POWER: "90,ac" } });
    assert.doesNotMatch(r.out, /^power:/m); // the cache is fresh: no probe
    putPower(sb, { battery: true, pct: 15, ac: false }, 2);
    r = coordRun(sb, ["tick"], { env: { HL_FAKE_POWER: "90,ac" } });
    assert.match(r.out, /^power: battery 90% on AC - the battery pause ended$/m);
    assert.equal(fs.existsSync(battery(sb)), false);
  } finally { sb.cleanup(); }
});

test("the watcher refreshes a battery every step, even a fresh cache, and clears the battery source on AC", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["watch", "--once"], { env: { HL_FAKE_POWER: "20,battery" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(battery(sb), "utf8")).pct, 20);
    r = coordRun(sb, ["watch", "--once"], { env: { HL_FAKE_POWER: "20,ac" } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nothing is paused or waiting to resume/);
    assert.equal(fs.existsSync(battery(sb)), false);
    assert.equal(JSON.parse(fs.readFileSync(power(sb), "utf8")).ac, true);
  } finally { sb.cleanup(); }
});

test("dry-run ticks never refresh power; post-tool claims the refresh but writes no power or battery files", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "P", id: "P@1", sid: "p-s1", mode: "bg", bg_id: "bg-P", supersedes: null });
    setAgents(sb, [{ id: "bg-P", sessionId: e.session_id, name: e.name, status: "running" }]);
    let r = coordRun(sb, ["tick", "--dry-run"], { env: { HL_FAKE_POWER: "10,battery" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.existsSync(power(sb)), false);
    assert.equal(fs.existsSync(battery(sb)), false);
    r = coordRun(sb, ["post-tool"], { input: { session_id: e.session_id, tool_name: "Read", tool_input: {} }, env: { HL_SESSION_ID: e.id, HL_FAKE_POWER: "10,battery" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "power-claim.json"), "utf8")).by, "post-tool");
    assert.equal(fs.existsSync(power(sb)), false);
    assert.equal(fs.existsSync(battery(sb)), false);
  } finally { sb.cleanup(); }
});
