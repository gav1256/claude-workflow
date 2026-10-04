import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun, sessionLine, setAgents, writeTranscript, tx } from "./helpers.mjs";

const GOAL_GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "goal-gate.mjs");
const gate = (sb, input, env = {}) => { const r = spawnSync(process.execPath, [GOAL_GATE], { env: { ...sb.env, ...env }, input: JSON.stringify(input), encoding: "utf8" }); return { code: r.status, out: r.stdout }; };
const queue = (sb, name, text) => {
  const d = path.join(sb.coord, "alerts"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `2026-01-01T00-00-00-000Z-${name}.json`), JSON.stringify({ text, incident: "i.md", created: "2026-01-01T00:00:00Z" }));
};
const claimedIn = (reason) => /alert-sent "([^"]+)"/.exec(reason)[1];

test("the phone relay: a non-launcher session claims one alert per Stop; sent or released; a stale claim returns", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    let r = gate(sb, { session_id: "s1" });
    assert.equal(r.code, 0);
    const o = JSON.parse(r.out);
    assert.equal(o.decision, "block");
    assert.match(o.reason, /^Coordinator alert\. Send this with PushNotification: Lane A is blocked\nThen run: node ".*coord\.mjs" alert-sent ".*\/alerts\/claimed-s1-\d{13}-2026-01-01T00-00-00-000Z-A\.json"/);
    assert.equal(gate(sb, { session_id: "s2" }).out, ""); // nothing left to claim, and no GOAL.md
    assert.equal(coordRun(sb, ["alert-release", claimedIn(o.reason)]).out, "alert released\n");
    r = gate(sb, { session_id: "s2" });
    assert.equal(coordRun(sb, ["alert-sent", claimedIn(JSON.parse(r.out).reason)]).out, "alert marked sent\n");
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f !== "index.json"), ["sent-2026-01-01T00-00-00-000Z-A.json"]);
    queue(sb, "B", "Lane B is blocked");
    const d = path.join(sb.coord, "alerts");
    fs.renameSync(path.join(d, "2026-01-01T00-00-00-000Z-B.json"), path.join(d, `claimed-s3-${Date.now() - 16 * 60000}-2026-01-01T00-00-00-000Z-B.json`));
    assert.match(coordRun(sb, ["tick"]).out, /^released the unsent alert 2026-01-01T00-00-00-000Z-B\.json$/m);
    assert.ok(fs.existsSync(path.join(d, "2026-01-01T00-00-00-000Z-B.json")));
    assert.match(coordRun(sb, ["alert-sent", path.join(sb.tmp, "x.json")]).out, /^not a claimed alert/);
  } finally { sb.cleanup(); }
});

test("a launcher session (HL_SESSION_ID) never relays; goal-gate starts the tick quietly, uses CFG, and fails open alone", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "x");
    assert.equal(gate(sb, { session_id: "s1" }, { HL_SESSION_ID: "A@1" }).out, "");
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "stop");
    assert.equal(fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f.startsWith("claimed-")).length, 0);
    const lone = path.join(sb.tmp, "hooks"); fs.mkdirSync(lone); fs.copyFileSync(GOAL_GATE, path.join(lone, "goal-gate.mjs"));
    fs.mkdirSync(path.join(sb.cfg, "goals"), { recursive: true }); fs.writeFileSync(path.join(sb.cfg, "goals", "s9.md"), "- [ ] open item\n");
    const run = (input) => spawnSync(process.execPath, [path.join(lone, "goal-gate.mjs")], { env: sb.env, input, encoding: "utf8" }).stdout;
    assert.equal(JSON.parse(run(JSON.stringify({ session_id: "s9" }))).decision, "block"); // CFG/goals fallback
    assert.equal(run("{}"), "");
    // The goal fallback is <CFG>/goals, never the home dir's .claude/goals while CLAUDE_CONFIG_DIR names another one. The
    // lone copy (no coord.mjs beside it) is the only one run without CLAUDE_CONFIG_DIR: nothing reaches a real coordinator.
    const home = path.join(sb.tmp, "home"); fs.mkdirSync(path.join(home, ".claude", "goals"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "goals", "s8.md"), "- [ ] open item\n");
    const { CLAUDE_CONFIG_DIR, ...noCfg } = sb.env;
    const runHome = (env) => spawnSync(process.execPath, [path.join(lone, "goal-gate.mjs")], { env: { ...env, USERPROFILE: home, HOME: home }, input: JSON.stringify({ session_id: "s8" }), encoding: "utf8" }).stdout;
    assert.equal(runHome(sb.env), "");
    assert.equal(JSON.parse(runHome(noCfg)).decision, "block"); // unset: CFG is ~/.claude
  } finally { sb.cleanup(); }
});

test("an alert file records the desktop notification result", () => {
  const sb = sandbox();
  try {
    const e = sessionLine(sb, { name: "R", sid: "r-1", mode: "bg", bg_id: "bg-R", coord: undefined });
    setAgents(sb, [{ id: "bg-R", sessionId: "r-1", name: "R", status: "running" }]);
    let t = tx({ start: Date.now() - 10 * 60000 }).user("go");
    for (let i = 0; i < 5; i++) t = t.call("Bash", { command: "poll" });
    writeTranscript(sb, sb.repo, e.session_id, t.entries());
    coordRun(sb, ["tick"]);
    const d = path.join(sb.coord, "alerts"), [f] = fs.readdirSync(d).filter((x) => /^\d/.test(x));
    assert.equal(JSON.parse(fs.readFileSync(path.join(d, f), "utf8")).desktop, "skipped (HL_NO_SPAWN)");
  } finally { sb.cleanup(); }
});

// D6: the relay subcommand on its own, as a Stop hook would run it.
test("coord.mjs relay: a non-launcher Stop prints the block JSON for one queued alert; a launcher session or a bad session id prints nothing", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    const d = path.join(sb.coord, "alerts"), claimed = () => fs.readdirSync(d).filter((f) => f.startsWith("claimed-"));
    let r = coordRun(sb, ["relay"], { input: { session_id: "s1" }, env: { HL_SESSION_ID: "A@1" } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    r = coordRun(sb, ["relay"], { input: { session_id: "../s1" } }); // a session id names the claim: a plain id only
    assert.equal(r.code, 0); assert.equal(r.out, "");
    assert.deepEqual(claimed(), []);
    r = coordRun(sb, ["relay"], { input: { session_id: "s1" } });
    assert.equal(r.code, 0);
    const o = JSON.parse(r.out);
    assert.equal(o.decision, "block");
    assert.match(o.reason, /^Coordinator alert\. Send this with PushNotification: Lane A is blocked\n/);
    assert.equal(claimed().length, 1);
    assert.equal(coordRun(sb, ["relay"], { input: { session_id: "s1" } }).out, ""); // one alert, claimed once
    assert.equal(coordRun(sb, ["relay"], { input: "not json" }).code, 0);
  } finally { sb.cleanup(); }
});

// ---------- fix round 1: the relay is bounded ----------
const claimedNow = (sb) => fs.readdirSync(path.join(sb.coord, "alerts")).filter((f) => f.startsWith("claimed-"));
test("the relay is bounded: one claim per user turn (never on a continuation Stop), never re-claimed by the session that released it", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    assert.equal(gate(sb, { session_id: "s1", stop_hook_active: true }).out, ""); // a continuation Stop never claims
    assert.deepEqual(claimedNow(sb), []);
    const c = claimedIn(JSON.parse(gate(sb, { session_id: "s1" }).out).reason);
    assert.equal(coordRun(sb, ["alert-release", c]).out, "alert released\n");
    const d = path.join(sb.coord, "alerts"), orig = path.join(d, "2026-01-01T00-00-00-000Z-A.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(orig, "utf8")).released_by, ["s1"]);
    assert.equal(JSON.parse(fs.readFileSync(orig, "utf8")).text, "Lane A is blocked");
    assert.equal(gate(sb, { session_id: "s1" }).out, ""); // the releasing session never takes it again: fresh Stop
    assert.equal(gate(sb, { session_id: "s1", stop_hook_active: true }).out, ""); // nor a continuation
    assert.equal(coordRun(sb, ["relay"], { input: { session_id: "s1" } }).out, "");
    const c2 = claimedIn(JSON.parse(gate(sb, { session_id: "s2" }).out).reason); // another session still can
    // A stale claim returned by the tick keeps its released_by.
    fs.renameSync(c2, path.join(d, `claimed-s2-${Date.now() - 16 * 60000}-2026-01-01T00-00-00-000Z-A.json`));
    assert.match(coordRun(sb, ["tick"]).out, /^released the unsent alert 2026-01-01T00-00-00-000Z-A\.json$/m);
    assert.deepEqual(JSON.parse(fs.readFileSync(orig, "utf8")).released_by, ["s1"]);
    assert.equal(gate(sb, { session_id: "s1" }).out, "");
    // A second release adds its sid once.
    const c3 = claimedIn(JSON.parse(gate(sb, { session_id: "s3" }).out).reason);
    coordRun(sb, ["alert-release", c3]);
    assert.deepEqual(JSON.parse(fs.readFileSync(orig, "utf8")).released_by, ["s1", "s3"]);
    assert.equal(coordRun(sb, ["relay"], { input: { session_id: "s4", stop_hook_active: true } }).out, ""); // the CLI follows the same rules
  } finally { sb.cleanup(); }
});

test("a relay block resets the goal gate's state for the turn, so the next continuation is an ordinary goal block", () => {
  const sb = sandbox();
  try {
    const goals = path.join(sb.cfg, "goals"), text = "- [ ] open item\n"; fs.mkdirSync(goals, { recursive: true });
    fs.writeFileSync(path.join(goals, "s1.md"), text);
    // Left behind by an earlier turn that ended on a question after two goal blocks.
    const hash = crypto.createHash("sha1").update(text).digest("hex"), st = path.join(goals, ".goal-gate-s1.json");
    fs.writeFileSync(st, JSON.stringify({ blocks: 2, lastHash: hash, finalAsked: false }));
    queue(sb, "A", "Lane A is blocked");
    assert.match(JSON.parse(gate(sb, { session_id: "s1" }).out).reason, /^Coordinator alert\./);
    assert.equal(fs.existsSync(st), false);
    assert.match(JSON.parse(gate(sb, { session_id: "s1", stop_hook_active: true }).out).reason, /^Goal gate \(continuation 1\/3\)/);
  } finally { sb.cleanup(); }
});

test("a turn that ends with a question is never relayed; the claim waits for the next Stop", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    assert.equal(gate(sb, { session_id: "s1", last_assistant_message: "Shall I merge it?" }).out, "");
    assert.equal(coordRun(sb, ["relay"], { input: { session_id: "s1", last_assistant_message: "Shall I merge it? " } }).out, "");
    assert.deepEqual(claimedNow(sb), []);
    assert.equal(JSON.parse(gate(sb, { session_id: "s1", last_assistant_message: "Done." }).out).decision, "block");
  } finally { sb.cleanup(); }
});

test("a Stop with background tasks running is never relayed (goal-gate's own exemption); an empty list still relays", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    const d = path.join(sb.coord, "alerts"), orig = path.join(d, "2026-01-01T00-00-00-000Z-A.json");
    const bg = [{ id: "b1", type: "local_bash", status: "running" }];
    let r = gate(sb, { session_id: "s1", background_tasks: bg });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    r = coordRun(sb, ["relay"], { input: { session_id: "s1", background_tasks: bg } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    assert.deepEqual(claimedNow(sb), []);
    assert.equal(fs.existsSync(orig), true); // the alert waits, unclaimed
    assert.equal(JSON.parse(fs.readFileSync(orig, "utf8")).released_by, undefined);
    r = coordRun(sb, ["relay"], { input: { session_id: "s1", background_tasks: [] } });
    assert.match(JSON.parse(r.out).reason, /^Coordinator alert\. Send this with PushNotification: Lane A is blocked\n/);
    assert.equal(claimedNow(sb).length, 1);
  } finally { sb.cleanup(); }
});

test("tick --dry-run lists the stale claims it would release and renames nothing", () => {
  const sb = sandbox();
  try {
    queue(sb, "B", "Lane B is blocked");
    const d = path.join(sb.coord, "alerts"), claim = path.join(d, `claimed-s3-${Date.now() - 16 * 60000}-2026-01-01T00-00-00-000Z-B.json`);
    fs.renameSync(path.join(d, "2026-01-01T00-00-00-000Z-B.json"), claim);
    assert.match(coordRun(sb, ["tick", "--dry-run"]).out, /^would release the unsent alert 2026-01-01T00-00-00-000Z-B\.json$/m);
    assert.ok(fs.existsSync(claim));
    assert.equal(fs.existsSync(path.join(d, "2026-01-01T00-00-00-000Z-B.json")), false);
  } finally { sb.cleanup(); }
});

test("goal-gate with coord.mjs present but its skill folder missing: exit 0, no output, no stderr", () => {
  const sb = sandbox();
  try {
    queue(sb, "A", "Lane A is blocked");
    const r = spawnSync(process.execPath, [GOAL_GATE], { env: { ...sb.env, HL_SKILL_DIR: path.join(sb.tmp, "no-such-skill") }, input: JSON.stringify({ session_id: "s1" }), encoding: "utf8" });
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
    assert.deepEqual(claimedNow(sb), []);
  } finally { sb.cleanup(); }
});
