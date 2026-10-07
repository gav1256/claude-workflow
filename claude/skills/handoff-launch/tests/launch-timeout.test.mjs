// A timed-out launcher may already have opened a window: its stale {starting} line never permits a second launch
// during the 30-min hold. The fake only writes registry lines and sleeps; no window or detached process is opened.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine } from "./helpers.mjs";
import { launchTimeoutPending } from "../recover-lib.mjs";

const MIN = 60000, RECOVER = new URL("../recover.mjs", import.meta.url).href;
const FAKE = `const fs = require("fs"), path = require("path");
const reg = path.join(process.env.HL_REGISTRY_DIR, "sessions.jsonl");
const e = fs.readFileSync(reg, "utf8").trim().split("\\n").map(JSON.parse).find(o => o.launched_at);
const at = new Date(Number(process.env.HL_TEST_NOW)).toISOString();
fs.appendFileSync(path.join(process.env.HL_TEST_TMP, "launches.txt"), "spawn\\n");
if (["ok", "registered", "other-group"].includes(process.env.HL_TEST_MODE)) {
  fs.appendFileSync(reg, JSON.stringify({ ...e, group: process.env.HL_TEST_MODE === "other-group" ? "g2" : e.group, id: e.name + "@2", generation: 2, launched_at: at, supersedes: e.id, no_spawn: true }) + "\\n");
  if (process.env.HL_TEST_MODE === "ok") process.exit(0);
} else fs.appendFileSync(reg, JSON.stringify({ starting: null, name: e.name, group: e.group, at }) + "\\n");
setTimeout(() => process.exit(1), 60000);
`;
const stateFile = (sb) => path.join(sb.coord, "pause", "tick-state.json");
const state = (sb) => JSON.parse(fs.readFileSync(stateFile(sb), "utf8"));
const launches = (sb) => fs.existsSync(path.join(sb.tmp, "launches.txt")) ? fs.readFileSync(path.join(sb.tmp, "launches.txt"), "utf8").trim().split("\n").length : 0;
const alerts = (sb) => fs.readdirSync(path.join(sb.coord, "alerts")).filter(f => f !== "index.json" && f.endsWith(".json"));
function fixture(kind, { name = "A", group = null } = {}) {
  const sb = sandbox(), now = Date.now(), at = new Date(now - 20 * MIN).toISOString();
  const e = sessionLine(sb, { name, group, sid: "s-a", supersedes: null });
  if (kind === "restart") {
    appendLine(sb, { incident: e.id, name: e.name, n: 1, path: path.join(sb.tmp, "incident.md"), signature: "a:main:x", rule: "a", mode: "auto", tokens: 1000, at });
    appendLine(sb, { kill_intent: e.id, name: e.name, kind: "ladder", at });
  } else appendLine(sb, { paused: e.id, name: e.name, source: "manual", reason: "manual pause", at });
  appendLine(sb, { closed: e.name, id: e.id, ...(kind === "resume" ? { pause: true } : {}), at });
  fs.writeFileSync(path.join(sb.tmp, "launcher.cjs"), FAKE);
  return { sb, now, e };
}
function tick(sb, now, { dryRun = false, mode = "timeout", repoKey = null, movingClock = false } = {}) {
  // The tick's existing Date clock: Date.now for decisions and new Date for registry/log stamps, both fixed so a
  // simulated 30 min also ages {starting} and a successful fake launch is newer than spawnLaunch's start stamp.
  const script = `import fs from "node:fs"; import path from "node:path"; const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [Number(process.env.HL_TEST_NOW)])); } static now() { return Number(process.env.HL_TEST_NOW) + (${movingClock} && fs.existsSync(path.join(process.env.HL_TEST_TMP, "launches.txt")) ? 31 * 60000 : 0); } }; const { tick } = await import(${JSON.stringify(RECOVER)}); console.log(tick(${JSON.stringify({ dryRun, repoKey })}).join("\\n"));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, timeout: 30000,
    env: { ...sb.env, HL_TEST_NOW: String(now), HL_TEST_TMP: sb.tmp, HL_TEST_MODE: mode, HL_LAUNCH_TIMEOUT_MS: mode === "ok" ? "20000" : "4000", HL_LAUNCH_MJS: path.join(sb.tmp, "launcher.cjs") } });
  assert.equal(r.status, 0, `${r.error || ""}\n${r.stderr}\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /tick failed:|^error /m);
  return r.stdout;
}
function snapshot(sb) {
  const files = {};
  const visit = (dir) => { if (!fs.existsSync(dir)) return; for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name); if (d.isDirectory()) visit(f); else files[path.relative(sb.tmp, f)] = fs.readFileSync(f).toString("base64");
  } };
  visit(sb.coord); visit(sb.reg); return files;
}
for (const kind of ["restart", "resume"]) {
  test(`${kind}: timeout holds a stale starting lane for 30 min and alerts once`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      assert.match(tick(sb, now), /launcher timed out at .*; not retried for 30 min - check for its window/);
      assert.deepEqual(state(sb).timedOut[e.id], { at: now, name: e.name, group: e.group });
      const logs = fs.readdirSync(path.join(sb.coord, "restarts"));
      assert.match(fs.readFileSync(path.join(sb.coord, "restarts", logs[0]), "utf8"), /^exit ETIMEDOUT$/m);
      assert.equal(launches(sb), 1);
      assert.equal(alerts(sb).length, 1);
      const index = JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", "index.json"), "utf8"));
      assert.ok(index[`timeout|${e.id}`]);
      assert.match(JSON.parse(fs.readFileSync(path.join(sb.coord, "alerts", alerts(sb)[0]), "utf8")).text, /check for (?:its|an open) window/i);
      assert.equal(state(sb).failed[e.id], undefined);
      assert.ok(!sb.registry().some(o => o.restart_failed || o.lane_blocked));
      for (const minutes of [2, 6, 29]) {
        const out = tick(sb, now + minutes * MIN);
        assert.match(out, /launcher timed out at .*; not retried for 30 min - check for its window/);
        assert.doesNotMatch(out, /UNTRACKED A: launcher died/);
        assert.equal(launches(sb), 1);
        assert.equal(alerts(sb).length, 1);
      }
    } finally { sb.cleanup(); }
  });
  test(`${kind}: after 30 min the normal launch resumes and the timeout record goes`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      tick(sb, now);
      assert.match(tick(sb, now + 30 * MIN, { mode: "ok" }), kind === "restart" ? /restarted A/ : /relaunched A/);
      assert.equal(launches(sb), 2);
      assert.equal(state(sb).timedOut[e.id], undefined);
    } finally { sb.cleanup(); }
  });
  test(`${kind}: a late launch line stamped before the timeout clears the hold without another spawn`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      tick(sb, now);
      sessionLine(sb, { name: e.name, id: "A@late", gen: 2, sid: "s-late", launched_at: new Date(now - MIN).toISOString(), supersedes: e.id }); // entry stamped before its slow window spawn finished
      const out = tick(sb, now + 6 * MIN);
      assert.doesNotMatch(out, /launcher timed out at/);
      assert.equal(state(sb).timedOut[e.id], undefined);
      assert.equal(launches(sb), 1);
    } finally { sb.cleanup(); }
  });
  test(`${kind}: dry runs would wait and never change state, even at expiry or a late launch`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      const initial = snapshot(sb);
      tick(sb, now, { dryRun: true });
      assert.deepEqual(snapshot(sb), initial);
      assert.equal(launches(sb), 0);
      tick(sb, now);
      let before = snapshot(sb);
      assert.match(tick(sb, now + 6 * MIN, { dryRun: true }), /^would wait A: launcher timed out at .*; not retried for 30 min - check for its window$/m);
      assert.deepEqual(snapshot(sb), before);
      tick(sb, now + 30 * MIN, { dryRun: true });
      assert.deepEqual(snapshot(sb), before);
      sessionLine(sb, { name: e.name, id: "A@late", gen: 2, launched_at: new Date(now + MIN).toISOString(), supersedes: e.id });
      before = snapshot(sb);
      tick(sb, now + 6 * MIN, { dryRun: true });
      assert.deepEqual(snapshot(sb), before);
      assert.equal(launches(sb), 1);
    } finally { sb.cleanup(); }
  });
  test(`${kind}: a launcher that registered before timing out gets no unregistered-timeout hold`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      const out = tick(sb, now, { mode: "registered" });
      assert.doesNotMatch(out, /launcher timed out at/);
      assert.match(out, /did not finish in 4000 ms/);
      const t = fs.existsSync(stateFile(sb)) ? state(sb) : {};
      assert.equal(t.timedOut?.[e.id], undefined);
      const indexFile = path.join(sb.coord, "alerts", "index.json");
      const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : {};
      assert.equal(index[`timeout|${e.id}`], undefined);
      assert.equal(launches(sb), 1);
      if (kind === "restart") assert.match(out, /but it registered the session/);
    } finally { sb.cleanup(); }
  });
}
test("a repository-scoped restart records and honors the timeout without changing pause fields", { timeout: 60000 }, () => {
  const { sb, now, e } = fixture("restart");
  try {
    const old = { skips: { "other@1": 2 }, failed: { "other@2": 1 }, probe: { id: "other@3", at: now }, custom: "kept" };
    fs.mkdirSync(path.dirname(stateFile(sb)), { recursive: true }); fs.writeFileSync(stateFile(sb), JSON.stringify(old));
    tick(sb, now, { repoKey: e.repo });
    assert.deepEqual(state(sb), { ...old, timedOut: { [e.id]: { at: now, name: e.name, group: e.group } } });
    assert.match(tick(sb, now + 6 * MIN, { repoKey: e.repo }), /launcher timed out at/);
    assert.equal(launches(sb), 1);
  } finally { sb.cleanup(); }
});
test("a second timeout after expiry raises one new alert for that timeout", { timeout: 60000 }, () => {
  const { sb, now, e } = fixture("resume");
  try {
    tick(sb, now); tick(sb, now + 30 * MIN);
    assert.equal(alerts(sb).length, 2);
    assert.deepEqual(state(sb).timedOut[e.id], { at: now + 30 * MIN, name: e.name, group: e.group });
    tick(sb, now + 36 * MIN);
    assert.equal(launches(sb), 2); assert.equal(alerts(sb).length, 2);
  } finally { sb.cleanup(); }
});

for (const kind of ["restart", "resume"]) {
  test(`${kind}: g2/impl registering during the timeout cannot suppress g1/impl's hold`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind, { name: "impl", group: "g1" });
    try {
      assert.match(tick(sb, now, { mode: "other-group" }), /launcher timed out at/);
      assert.deepEqual(state(sb).timedOut[e.id], { at: now, name: "impl", group: "g1" });
      assert.match(tick(sb, now + 6 * MIN), /wait impl: launcher timed out at/);
      assert.equal(launches(sb), 1);
      assert.ok(state(sb).timedOut[e.id]);
      sessionLine(sb, { name: "impl", group: "g1", id: "impl@late", gen: 2, launched_at: new Date(now - MIN).toISOString(), supersedes: e.id });
      tick(sb, now + 7 * MIN);
      assert.equal(state(sb).timedOut[e.id], undefined);
      assert.equal(launches(sb), 1);
    } finally { sb.cleanup(); }
  });
  test(`${kind}: a launch that advances the clock stamps the real time and the next tick still holds`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      assert.match(tick(sb, now, { movingClock: true }), /launcher timed out at/);
      assert.ok(state(sb).timedOut[e.id]); // decision: held (the moving clock did not expire it); `at` is only the real time seen
      assert.equal(launches(sb), 1);
      assert.match(tick(sb, now + MIN, { movingClock: true }), /wait A: launcher timed out at/);
      assert.equal(launches(sb), 1);
      assert.match(tick(sb, now + 31 * MIN, { movingClock: true, mode: "ok" }), kind === "restart" ? /restarted A/ : /relaunched A/);
      assert.equal(launches(sb), 2);
    } finally { sb.cleanup(); }
  });
  test(`${kind}: a clock rollback beyond one minute expires the hold and retries`, { timeout: 60000 }, () => {
    const { sb, now, e } = fixture(kind);
    try {
      tick(sb, now);
      const future = state(sb); future.timedOut[e.id].at = now + 8 * MIN;
      fs.writeFileSync(stateFile(sb), JSON.stringify(future));
      assert.match(tick(sb, now + 6 * MIN, { mode: "ok" }), kind === "restart" ? /restarted A/ : /relaunched A/);
      assert.equal(state(sb).timedOut[e.id], undefined);
      assert.equal(launches(sb), 2);
    } finally { sb.cleanup(); }
  });
}

test("the timeout clock tolerates one minute of skew, expires past it, and clears only the same name and group", () => {
  const now = Date.now(), t = { at: now, name: "impl", group: "g1" };
  const lines = [{ id: "impl@1", name: "impl", group: "g1", launched_at: new Date(now - MIN).toISOString() }];
  assert.equal(launchTimeoutPending(t, lines, now - MIN, "impl@1"), true);
  assert.equal(launchTimeoutPending(t, lines, now - MIN - 1, "impl@1"), false);
  lines.push({ id: "other@1", name: "impl", group: "g2", launched_at: new Date(now).toISOString() });
  assert.equal(launchTimeoutPending(t, lines, now, "impl@1"), true);
  lines.push({ id: "impl@2", name: "impl", group: "g1", launched_at: new Date(now - MIN).toISOString() });
  assert.equal(launchTimeoutPending(t, lines, now, "impl@1"), false);
});

test("readTickState accepts only a plain object for timedOut without writing the file", { timeout: 60000 }, () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.dirname(stateFile(sb)), { recursive: true });
    for (const value of [null, [], "bad", 1, true, { "A@1": { at: 123, name: "A", group: null } }]) {
      fs.writeFileSync(stateFile(sb), JSON.stringify({ timedOut: value }));
      const before = fs.readFileSync(stateFile(sb), "utf8");
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const { readTickState } = await import(${JSON.stringify(RECOVER)}); console.log(JSON.stringify(readTickState().timedOut));`], { env: sb.env, encoding: "utf8", windowsHide: true, timeout: 10000 });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), value && typeof value === "object" && !Array.isArray(value) ? value : {});
      assert.equal(fs.readFileSync(stateFile(sb), "utf8"), before);
    }
  } finally { sb.cleanup(); }
});
