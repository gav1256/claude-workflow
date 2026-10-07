// S5: inject the clock in every child; all files and process fixtures belong to the sandbox.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { sandbox, coordRun, COORD_MJS, sessionLine, appendLine, setAgents, writeTranscript, tx } from "./helpers.mjs";

const MIN = 60000, NOW = Date.UTC(2026, 9, 7, 15), iso = (t) => new Date(t).toISOString();
const RECOVER = new URL("../recover.mjs", import.meta.url).href;
const PI_URL = new URL("../pause-io.mjs", import.meta.url).href;
const table = (sb, start, end) => fs.writeFileSync(sb.offtimes, JSON.stringify({ tz: "Asia/Jerusalem", until: NOW + 100 * 864e5, intervals: [{ start, end, kind: "shabbat" }] }));
const put = (sb, file, obj) => { const f = path.join(sb.coord, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
const read = (sb, file) => JSON.parse(fs.readFileSync(path.join(sb.coord, file), "utf8"));
function child(sb, code, { env = {}, now = NOW } = {}) {
  const clock = `const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [${now}])); } static now() { return ${now}; } };`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", clock + code], { env: { ...sb.env, ...env }, encoding: "utf8", windowsHide: true, timeout: 120000 });
  assert.equal(r.status, 0, r.stderr || r.error?.message);
  return r.stdout.replace(/\r/g, "");
}
const tick = (sb, dryRun = false, prefix = "") => child(sb, `${prefix} const R = await import(${JSON.stringify(RECOVER)}); console.log(R.tick({dryRun: ${dryRun}}).join("\\n"));`);
const watch = (sb) => child(sb, `process.argv = [process.execPath, ${JSON.stringify(COORD_MJS)}, "watch", "--once"]; await import(${JSON.stringify(pathToFileURL(COORD_MJS).href)});`);
// coordRun supplies the normal CLI path; only its clock is replaced for resume.
const resume = (sb, now = NOW) => coordRun(sb, ["resume"], { env: { NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(`const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${now}]))}static now(){return ${now}}}`)}` } });
function lane(sb, name, { closed = false, source = "shabbat", end = NOW - MIN } = {}) {
  const e = sessionLine(sb, { name, sid: `${name}-s1`, mode: "bg", bg_id: `bg-${name}`, launched_at: iso(NOW - 120 * MIN), supersedes: null });
  if (closed) {
    appendLine(sb, { paused: e.id, name, source, end, at: iso(NOW - 90 * MIN), reason: "saved", windows: [] });
    appendLine(sb, { closed: name, id: e.id, pause: true, at: iso(NOW - 80 * MIN) });
  } else {
    writeTranscript(sb, sb.repo, e.session_id, tx({ start: NOW - MIN }).user("go").call("mcp__x__slow", {}, { result: false }).entries());
    setAgents(sb, [{ id: e.bg_id, sessionId: e.session_id, name, status: "running" }]);
  }
  return e;
}
const alerts = (sb) => fs.existsSync(path.join(sb.coord, "alerts")) ? fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f.endsWith("-paused.json")) : [];

test("a closed shabbat row relaunches only after the resume request", () => {
  const sb = sandbox();
  try {
    lane(sb, "S", { closed: true }); // its own end works even with an empty valid table
    assert.doesNotMatch(tick(sb, true), /would relaunch/);
    const r = resume(sb); assert.equal(r.code, 0, r.err);
    assert.match(r.out, /resume request recorded: lanes paused over Shabbat\/Yom Tov relaunch now/);
    assert.match(tick(sb, true), /would relaunch S after its pause/);
    assert.deepEqual(read(sb, "pause/resume-request.json"), { at: NOW, enabled: true });
  } finally { sb.cleanup(); }
});
test("resume records the switch and asks again while Shabbat is still on", () => {
  const sb = sandbox();
  try {
    table(sb, NOW + 30 * MIN, NOW + 120 * MIN);
    const r = resume(sb); assert.equal(r.code, 0, r.err);
    assert.match(r.out, /resume request recorded, but Shabbat\/Yom Tov is still on: run \/broadcast resume again after nightfall/);
    put(sb, "shabbos.json", { enabled: false });
    assert.equal(resume(sb).code, 0);
    assert.deepEqual(read(sb, "pause/resume-request.json"), { at: NOW, enabled: false });
    assert.equal(child(sb, `const PI=await import(${JSON.stringify(PI_URL)}); console.log(JSON.stringify(PI.readResumeRequest()));`).trim(), '{"at":' + NOW + ',"enabled":false}');
    put(sb, "pause/resume-request.json", { at: "bad" });
    assert.equal(child(sb, `const PI=await import(${JSON.stringify(PI_URL)}); console.log(PI.readResumeRequest());`).trim(), "null");
  } finally { sb.cleanup(); }
});
test("the watcher does not tick during off-time", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 3 * MIN, NOW + 60 * MIN);
    assert.equal(watch(sb), "watch: one step done\n");
    for (const f of ["last-tick.txt", "pace.json", "power.json"]) assert.equal(fs.existsSync(path.join(sb.coord, f)), false, f);
    lane(sb, "B");
    assert.match(watch(sb), /watch: one step done \(a tick ran\)/);
    for (const f of ["pace.json", "power.json"]) assert.equal(fs.existsSync(path.join(sb.coord, f)), false, f);
    put(sb, "pause/tick-state.json", { alerted: ["B@1"] });
    const last = fs.readFileSync(path.join(sb.coord, "last-tick.txt"), "utf8");
    assert.equal(watch(sb), "watch: one step done\n");
    assert.equal(fs.readFileSync(path.join(sb.coord, "last-tick.txt"), "utf8"), last);
  } finally { sb.cleanup(); }
});
test("the off-time watcher ignores the five-minute back-off", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 3 * MIN, NOW + 60 * MIN); lane(sb, "B");
    const url = pathToFileURL(COORD_MJS).href;
    const out = child(sb, `const C=await import(${JSON.stringify(url)}); console.log(JSON.stringify(await C.watchStep({now:${NOW},started:${NOW},last:{at:${NOW - 1000},acted:false}})));`);
    assert.equal(JSON.parse(out).ticked, true);
  } finally { sb.cleanup(); }
});
test("after nightfall the watcher stops with only waiting rows", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 60 * MIN, NOW - MIN); lane(sb, "M", { closed: true, source: "manual", end: null });
    assert.equal(watch(sb), "watch: stopped - nothing is paused or waiting to resume\n");
    assert.doesNotMatch(tick(sb), /watcher started|relaunched/);
    assert.equal(fs.existsSync(path.join(sb.coord, "watch-start.json")), false);
  } finally { sb.cleanup(); }
});
test("nightfall raises no hand-opened alert; the resume marks it without one", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 60 * MIN, NOW - MIN);
    put(sb, "paused.json", { paused_at: iso(NOW - 90 * MIN), sessions: [{ key: "hand:h-s1", session_id: "h-s1", closed: false }] });
    tick(sb); assert.deepEqual(alerts(sb), []);
    assert.equal(read(sb, "paused.json").hand_alerted, undefined);
    assert.equal(resume(sb).code, 0); tick(sb);
    const archived = fs.readdirSync(sb.coord).find((f) => /^paused-.*\.json$/.test(f));
    const m = read(sb, archived || "paused.json");
    assert.equal(m.hand_via, "resume"); assert.ok(m.hand_alerted); assert.deepEqual(alerts(sb), []);
  } finally { sb.cleanup(); }
});
test("a spanned manifest archives after all closed rows resumed by hand unless a hand row waits", () => {
  for (const handWaiting of [false, true]) {
    const sb = sandbox();
    try {
      table(sb, NOW - 60 * MIN, NOW - MIN);
      const closed = { key: "lane:S", name: "S", closed: true, resumed_at: iso(NOW - 30000) };
      const hands = handWaiting ? [{ key: "hand:h-s1", session_id: "h-s1", closed: false }] : [];
      put(sb, "paused.json", { paused_at: iso(NOW - 90 * MIN), sessions: [closed, ...hands] });
      const out = tick(sb);
      assert.equal(fs.existsSync(path.join(sb.coord, "pause/resume-request.json")), false);
      assert.equal(fs.existsSync(path.join(sb.coord, "paused.json")), handWaiting);
      const archived = fs.readdirSync(sb.coord).find((f) => /^paused-.*\.json$/.test(f));
      assert.equal(Boolean(archived), !handWaiting);
      if (handWaiting) {
        assert.doesNotMatch(out, /pause manifest archived/);
        assert.equal(read(sb, "paused.json").hand_alerted, undefined);
      } else {
        assert.match(out, /pause manifest archived/);
        assert.equal(read(sb, archived).sessions[0].resumed_at, closed.resumed_at);
      }
      assert.deepEqual(alerts(sb), []);
    } finally { sb.cleanup(); }
  }
});
test("the last working tick before Shabbat starts the watcher", () => {
  const sb = sandbox();
  try {
    table(sb, NOW + 90 * MIN, NOW + 180 * MIN);
    assert.doesNotMatch(tick(sb), /watcher started/);
    lane(sb, "B");
    assert.match(tick(sb), /watcher started \(Shabbat\/Yom Tov begins within 2 h\)/);
  } finally { sb.cleanup(); }
});
test("the watcher keeps running before Shabbat while a lane is open", () => {
  const sb = sandbox();
  try {
    table(sb, NOW + 90 * MIN, NOW + 180 * MIN); lane(sb, "B");
    assert.equal(watch(sb), "watch: one step done\n");
  } finally { sb.cleanup(); }
});
test("one failed Shabbat mark does not abort the tick or the next lane's mark", () => {
  const sb = sandbox();
  try {
    table(sb, NOW - 3 * MIN, NOW + 60 * MIN); lane(sb, "A"); lane(sb, "B");
    setAgents(sb, ["A", "B"].map((name) => ({ id: `bg-${name}`, sessionId: `${name}-s1`, name, status: "running" })));
    const prefix = `const fs=(await import("node:fs")).default, append=fs.appendFileSync; fs.appendFileSync=(f,text,...a)=>{ if(String(f).endsWith("sessions.jsonl") && JSON.parse(text).paused==="A@1") throw Object.assign(new Error("registry busy"),{code:"EBUSY"}); return append(f,text,...a); };`;
    const out = tick(sb, false, prefix);
    assert.match(out, /^error A: registry busy/m);
    assert.match(out, /Shabbat\/Yom Tov: \{paused\} written for B/);
    assert.doesNotMatch(out, /tick failed/);
    assert.equal(sb.registry().some((o) => o.paused === "B@1"), true);
  } finally { sb.cleanup(); }
});
