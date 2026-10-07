// Batch B, Part 4 on disk: the pause source files (pause-io.mjs) and `coord.mjs pause | resume`.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, coordRun, COORD_MJS } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const MIN = 60000;
const PIO = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pause-io.mjs")).href;
// pause-io's pauseForNow/pauseActive in a child with the sandbox env (pause-io reads CLAUDE_CONFIG_DIR at import).
const ask = (sb, expr) => JSON.parse(spawnSync(process.execPath, ["--input-type=module", "-e", `const PI = await import(${JSON.stringify(PIO)}); process.stdout.write(JSON.stringify(${expr}));`], { env: sb.env, encoding: "utf8" }).stdout);
const manual = (sb) => path.join(sb.coord, "pause", "manual.json");
const put = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };

test("coord.mjs pause: no end, 30m, until HH:MM; the pause text to broadcast; a tick claimed at once; bad arguments exit 2", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["pause"], { env: { HL_SESSION_ID: "M@1" } });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `paused: manual pause\nBroadcast: ${PAUSE_TEXT("manual pause")}\n`);
    const m = JSON.parse(fs.readFileSync(manual(sb), "utf8"));
    assert.deepEqual([m.until, m.by, typeof m.at], [null, "M@1", "string"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "pause"); // HL_NO_SPAWN: claimed, not started
    r = coordRun(sb, ["pause", "30m"]);
    const until = Date.parse(JSON.parse(fs.readFileSync(manual(sb), "utf8")).until);
    assert.ok(Math.abs(until - (Date.now() + 30 * MIN)) < MIN);
    assert.match(r.out, /^paused: manual pause until \d{4}-\d\d-\d\dT\d\d:\d\dZ$/m);
    r = coordRun(sb, ["pause", "until", "23:59"]);
    assert.equal(r.code, 0); assert.equal(new Date(JSON.parse(fs.readFileSync(manual(sb), "utf8")).until).getMinutes(), 59);
    for (const bad of [["soon"], ["until", "7pm"]]) { r = coordRun(sb, ["pause", ...bad]); assert.equal(r.code, 2, bad.join(" ")); assert.match(r.out, /^pause takes /); }
  } finally { sb.cleanup(); }
});

test("coord.mjs resume removes the manual source and the legacy pause.json; another source still active is named", () => {
  const sb = sandbox();
  try {
    coordRun(sb, ["pause"]);
    put(path.join(sb.coord, "pause.json"), { until: null });
    let r = coordRun(sb, ["resume"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^resumed: removed manual\.json, pause\.json$/m);
    assert.match(r.out, /^Broadcast: resume your saved work\.$/m);
    assert.equal(fs.existsSync(manual(sb)), false); assert.equal(fs.existsSync(path.join(sb.coord, "pause.json")), false);
    put(path.join(sb.coord, "pause", "battery.json"), { at: new Date().toISOString(), pct: 15, ac: false });
    r = coordRun(sb, ["resume"]);
    assert.match(r.out, /^resumed: no manual pause was set$/m);
    assert.match(r.out, /^still paused by: battery 15%$/m);
  } finally { sb.cleanup(); }
});

test("pause-io: pauseActive and pauseForNow over every source; the old pause.json shape counts; an expired until does not", () => {
  const sb = sandbox();
  try {
    assert.equal(ask(sb, "PI.pauseActive()"), false);
    put(path.join(sb.coord, "pause.json"), { until: new Date(Date.now() + MIN).toISOString() });
    assert.equal(ask(sb, "PI.pauseActive()"), true);
    put(path.join(sb.coord, "pause.json"), { until: new Date(Date.now() - MIN).toISOString() });
    assert.equal(ask(sb, "PI.pauseActive()"), false);
    put(path.join(sb.coord, "pace.json"), { updated: Date.now(), claude: { state: "hold", ahead: 22, week_ahead: 1, since: Date.now(), windows: { five_hour: { state: "hold" }, weekly: { state: "ok" } } } });
    assert.deepEqual(ask(sb, `["high", "normal", "low"].map((p) => PI.pauseForNow(p).paused)`), [false, true, true]);
    assert.equal(ask(sb, `PI.pauseForNow("low").reason`), "pace hold (5h +22 / week +1)");
  } finally { sb.cleanup(); }
});

test("contention on one source file: eight pause commands at once leave one whole manual.json (one of theirs), no temp file", async () => {
  const sb = sandbox();
  try {
    const run = (args) => new Promise((done) => spawn(process.execPath, [COORD_MJS, ...args], { env: sb.env, windowsHide: true, stdio: "ignore" }).on("exit", done));
    const argsList = [[], ["30m"], ["2h"], ["5m"], ["45m"], ["3h"], ["10m"], ["until", "23:59"]];
    for (let round = 0; round < 3; round++) {
      await Promise.all(argsList.map((a) => run(["pause", ...a])));
      const m = JSON.parse(fs.readFileSync(manual(sb), "utf8")); // parses: never a torn file
      assert.deepEqual(Object.keys(m).sort(), ["at", "by", "until"]);
      assert.deepEqual(fs.readdirSync(path.join(sb.coord, "pause")).filter((f) => f.endsWith(".tmp")), []);
    }
    // The sources never share a file (one writer each), so a manual write cannot lose a battery write: pause-io names them.
    const PIO2 = await import(PIO);
    assert.equal(new Set([PIO2.MANUAL, PIO2.BATTERY, PIO2.LEGACY]).size, 3);
  } finally { sb.cleanup(); }
});
