// Usage pause switch: sandboxed CLI, hooks, watcher and historical pace pauses; readings stay intact.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { activeSources } from "../pause-lib.mjs";
import { sandbox, coordRun, sessionLine, appendLine, setAgents, writeTranscript, tx } from "./helpers.mjs";

const MIN = 60000, OFF = "usage pause: off (pace readings no longer pause lanes)\n", ON = "usage pause: on\n";
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const switchFile = (sb) => path.join(sb.coord, "pause", "pace-off.json");
const pace = (state = "hold") => ({ updated: Date.now(), claude: { state, pct: 42, week_pct: 31, ahead: 22, week_ahead: 3, since: Date.now() - 30 * MIN, windows: { five_hour: { state, basis: "fresh" }, weekly: { state: "ok" } } } });
const run = (sb, args, options) => { const r = coordRun(sb, args, options); assert.equal(r.code, 0, r.err || r.out); return r.out; };
const gate = (sb, id, sid) => {
  const out = run(sb, ["agent-gate"], { env: { HL_SESSION_ID: id }, input: { session_id: sid, tool_name: "Agent", tool_input: {} } });
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const stop = (sb, id, sid, continuation = false) => run(sb, ["stop"], { env: { HL_SESSION_ID: id }, input: { session_id: sid, hook_event_name: "Stop", stop_hook_active: continuation } });

test("activeSources: paceOff drops only pace for hold and exhausted, preserving manual, legacy and battery", () => {
  const now = Date.now(), at = new Date(now).toISOString();
  for (const state of ["hold", "exhausted"]) {
    const files = { manual: { until: null, at }, battery: { at, pct: 9 }, pace: pace(state) };
    assert.deepEqual(activeSources(files, now).map((s) => s.source), ["manual", "battery", "pace"]);
    assert.deepEqual(activeSources({ ...files, paceOff: true }, now), activeSources({ ...files, pace: null }, now));
    assert.equal(activeSources({ legacy: { until: null, at }, pace: files.pace, paceOff: true }, now)[0].source, "manual");
  }
});

test("usage-pause CLI: default on, atomic off with by/at, status, on removes only the switch, absent on is a no-op", () => {
  const sb = sandbox();
  try {
    assert.equal(run(sb, ["usage-pause"]), ON);
    assert.equal(run(sb, ["usage-pause", "on"]), ON);
    assert.equal(fs.existsSync(path.join(sb.coord, "pause")), false);
    const before = Date.now();
    assert.equal(run(sb, ["usage-pause", "off", "--by", "test@example.com"]), OFF);
    const o = JSON.parse(fs.readFileSync(switchFile(sb), "utf8"));
    assert.deepEqual(Object.keys(o).sort(), ["at", "by"]);
    assert.equal(o.by, "test@example.com");
    assert.ok(Date.parse(o.at) >= before && Date.parse(o.at) <= Date.now());
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "usage-pause");
    run(sb, ["usage-pause", "off", "--by", "other@example.com"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(switchFile(sb), "utf8")), o); // already off preserves at and by
    assert.equal(run(sb, ["usage-pause"]), OFF);
    assert.deepEqual(fs.readdirSync(path.dirname(switchFile(sb))), ["pace-off.json"]);
    const manual = path.join(sb.coord, "pause", "manual.json");
    put(manual, { until: null, at: o.at, by: "test@example.com" });
    assert.equal(run(sb, ["usage-pause", "on"]), ON);
    assert.equal(fs.existsSync(switchFile(sb)), false);
    assert.equal(fs.existsSync(manual), true);
    assert.equal(run(sb, ["usage-pause"]), ON);
    run(sb, ["usage-pause", "off"], { env: { HL_SESSION_ID: "N@1" } });
    assert.equal(JSON.parse(fs.readFileSync(switchFile(sb), "utf8")).by, "N@1");
    for (const args of [["bad"], ["off", "--by"], ["on", "extra"]]) assert.equal(coordRun(sb, ["usage-pause", ...args]).code, 1);
    run(sb, ["usage-pause", "on"]);
    fs.mkdirSync(switchFile(sb)); // deletion/write errors are visible CLI failures
    assert.equal(coordRun(sb, ["usage-pause", "off"]).code, 1);
    assert.equal(coordRun(sb, ["usage-pause", "on"]).code, 1);
  } finally { sb.cleanup(); }
});

test("usage pause off: hold/exhausted keep B1 low Agent denial and normal notice, allow Stop; on restores pauses", () => {
  const sb = sandbox();
  try {
    for (const [name, effort] of [["H", "xhigh"], ["N", "high"], ["L", "medium"]]) sessionLine(sb, { name, id: `${name}@1`, sid: `${name}-s1`, effort, mode: "bg", bg_id: `bg-${name}`, supersedes: null });
    setAgents(sb, ["H", "N", "L"].map((name) => ({ id: `bg-${name}`, sessionId: `${name}-s1`, name, status: "idle" })));
    run(sb, ["usage-pause", "off"]);
    for (const state of ["hold", "exhausted", "slow"]) {
      put(path.join(sb.coord, "pace.json"), pace(state));
      const reading = fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8");
      assert.doesNotMatch(run(sb, ["tick", "--dry-run"]), /would start the watcher|would close|would relaunch/);
      for (const name of ["H", "N", "L"]) {
        const d = gate(sb, `${name}@1`, `${name}-${state}`);
        if (name === "L") {
          assert.equal(d.permissionDecision, "deny");
          assert.match(d.permissionDecisionReason, /Low-priority lanes start no new agents/);
          assert.doesNotMatch(d.permissionDecisionReason, /Paused/);
        } else {
          assert.notEqual(d.permissionDecision, "deny");
          assert.match(d.additionalContext, /step effort down/);
        }
        assert.equal(stop(sb, `${name}@1`, `${name}-s1`), "");
        assert.equal(stop(sb, `${name}@1`, `${name}-s1`, true), "");
      }
      assert.equal(fs.readFileSync(path.join(sb.coord, "pace.json"), "utf8"), reading);
      assert.equal(sb.registry().filter((o) => o.paused || o.closed).length, 0);
    }
    put(path.join(sb.coord, "pace.json"), pace());
    run(sb, ["usage-pause", "on"]);
    assert.match(run(sb, ["tick", "--dry-run"]), /would start the watcher/);
    assert.equal(gate(sb, "N@1", "control-s1").permissionDecision, "deny");
    assert.equal(JSON.parse(stop(sb, "N@1", "N-s1")).decision, "block");
    run(sb, ["usage-pause", "off"]);
    for (const [source, data] of [["manual", { until: null, by: "test@example.com", at: new Date().toISOString() }], ["battery", { pct: 9, ac: false, at: new Date().toISOString() }]]) {
      const file = path.join(sb.coord, "pause", `${source}.json`); put(file, data);
      assert.equal(gate(sb, "H@1", `${source}-s1`).permissionDecision, "deny");
      assert.match(JSON.parse(stop(sb, "N@1", "N-s1")).reason, new RegExp(source));
      assert.match(run(sb, ["tick", "--dry-run"]), /would start the watcher/);
      fs.rmSync(file);
    }
  } finally { sb.cleanup(); }
});

test("usage pause off: historical pace pauses lift through close and resume, retaining minimum pause and probe", () => {
  const sb = sandbox();
  try {
    const at = new Date(Date.now() - 30 * MIN).toISOString();
    for (const name of ["Open", "Closed"]) {
      const e = sessionLine(sb, { name, sid: `${name}-s1`, mode: "bg", bg_id: `bg-${name}`, supersedes: null });
      appendLine(sb, { paused: e.id, name, at, source: "pace", reason: "pace hold", windows: ["five_hour"] });
      writeTranscript(sb, e.worktree, e.session_id, tx({ start: Date.now() - 40 * MIN }).user("go").say("saved").turnDone().entries());
      if (name === "Closed") appendLine(sb, { closed: name, id: e.id, at, pause: true });
    }
    setAgents(sb, [{ id: "bg-Open", sessionId: "Open-s1", name: "Open", status: "idle" }]);
    put(path.join(sb.coord, "pace.json"), pace());
    assert.match(run(sb, ["tick", "--dry-run"]), /would close Open/);
    run(sb, ["usage-pause", "off"]);
    const lifted = run(sb, ["tick", "--dry-run"]);
    assert.match(lifted, /would close Open/);
    assert.match(lifted, /would relaunch Closed/);
    assert.match(lifted, /would start the watcher/);
    const manual = sb.run("resume", "--paused", "--all", "--dry-run");
    assert.equal(manual.code, 0, manual.err);
    assert.match(manual.out, /would relaunch Closed/);
    appendLine(sb, { closed: "Closed", id: "Closed@1", at: new Date(Date.now() - 5 * MIN).toISOString(), pause: true });
    assert.doesNotMatch(run(sb, ["tick", "--dry-run"]), /would relaunch Closed/);
    appendLine(sb, { closed: "Closed", id: "Closed@1", at, pause: true });
    const stale = pace(); stale.claude.windows.five_hour.basis = "stale";
    put(path.join(sb.coord, "pace.json"), stale);
    assert.match(run(sb, ["tick", "--dry-run"]), /would relaunch Closed.*probe/);
  } finally { sb.cleanup(); }
});

test("status and sessions show usage pause off with fresh, stale or absent pace readings", () => {
  const sb = sandbox();
  try {
    sessionLine(sb, { name: "N", group: "g1", sid: "N-s1", supersedes: null });
    put(path.join(sb.coord, "pace.json"), pace());
    const before = sb.run("status", "--group", "g1").out;
    run(sb, ["usage-pause", "off"]);
    for (const args of [["status", "--group", "g1"], ["sessions"]]) {
      const r = sb.run(...args); assert.equal(r.code, 0, r.err);
      assert.match(r.out.split("\n")[0], /^pace: /);
      assert.match(r.out, /^usage pause: off$/m);
    }
    run(sb, ["usage-pause", "on"]);
    assert.equal(sb.run("status", "--group", "g1").out, before);
    run(sb, ["usage-pause", "off"]);
    const stale = pace(); stale.updated = Date.now() - 60 * MIN;
    for (const reading of [stale, null]) {
      if (reading) put(path.join(sb.coord, "pace.json"), reading);
      else fs.rmSync(path.join(sb.coord, "pace.json"));
      for (const args of [["status", "--group", "g1"], ["sessions"]]) {
        const r = sb.run(...args); assert.equal(r.code, 0, r.err);
        assert.match(r.out, /^usage pause: off$/m);
        assert.doesNotMatch(r.out, /^pace:/m);
      }
    }
  } finally { sb.cleanup(); }
});
