import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, coordRun } from "./helpers.mjs";
import * as R from "../recover-lib.mjs";

const SID = "11111111-2222-3333-4444-555555555555", REG_ID = "A@2026-01-01T00-00-00-000Z";
const ev = (o) => ({ session_id: SID, transcript_path: "/t.jsonl", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "a" }, ...o });
const ctxOf = (r) => (r.out ? JSON.parse(r.out).hookSpecificOutput.additionalContext : null);
const hook = (sb, input, env = { HL_SESSION_ID: REG_ID }) => coordRun(sb, ["post-tool"], { input, env });
const state = (sb) => JSON.parse(fs.readFileSync(path.join(sb.coord, "sessions", `${SID}.json`), "utf8"));

test("post-tool steps 1-5 in order: stop (parent only), subagent notice, parent fast path, early warning, tick trigger", () => {
  const sb = sandbox();
  try {
    fs.mkdirSync(path.join(sb.reg, "stops"), { recursive: true });
    fs.writeFileSync(path.join(sb.reg, "stops", "A-2026-01-01T00-00-00-000Z.manual.stop.json"), JSON.stringify({ id: REG_ID, token: "tok1", text: "STOP NOW" }));
    fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ [SID]: { ag2: { key: 'Bash {"command":"loop"}', type: "worker-high", text: "same call x5", transcript: "/t/agent-ag2.jsonl" } } }));
    assert.equal(ctxOf(hook(sb, ev({ agent_id: "ag2", agent_type: "worker-high", tool_name: "Bash", tool_input: { command: "loop" } }))), R.SUBAGENT_TEXT('Bash {"command":"loop"}'));
    assert.equal(ctxOf(hook(sb, ev({}))), "STOP NOW");
    assert.ok(sb.registry().some((o) => o.stop_delivered === REG_ID && o.token === "tok1"));
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "b" } }))), R.PARENT_TEXT({ type: "worker-high", id: "ag2", reason: "same call x5", transcript: "/t/agent-ag2.jsonl" }));
    const outs = [1, 2, 3, 4].map(() => ctxOf(hook(sb, ev({ tool_name: "Bash", tool_input: { command: "poll" } }))));
    assert.deepEqual(outs, [null, null, R.WARN_TEXT('Bash {"command":"poll"}', 3), null]);
    assert.equal(sb.registry().filter((o) => o.stop_delivered).length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "post-tool"); // HL_NO_SPAWN: recorded, not started
  } finally { sb.cleanup(); }
});

test("stop files per reason class: the ladder's goes first, then the others, each once", () => {
  const sb = sandbox();
  try {
    const d = path.join(sb.reg, "stops"), at = new Date().toISOString();
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.close.stop.json"), JSON.stringify({ id: REG_ID, token: "c1", text: "CLOSE STOP", at }));
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.ladder.stop.json"), JSON.stringify({ id: REG_ID, token: "l1", text: "LADDER STOP", at }));
    assert.equal(ctxOf(hook(sb, ev({}))), "LADDER STOP");
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "b" } }))), "CLOSE STOP");
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "c" } }))), null);
    assert.deepEqual(sb.registry().filter((o) => o.stop_delivered).map((o) => o.token), ["l1", "c1"]);
  } finally { sb.cleanup(); }
});

test("notify records waiting_since for a permission prompt only; the next tool call clears it", () => {
  const sb = sandbox();
  try {
    const n = (o) => coordRun(sb, ["notify"], { input: { session_id: SID, hook_event_name: "Notification", ...o }, env: { HL_SESSION_ID: REG_ID } });
    assert.equal(n({ notification_type: "idle_prompt", message: "Claude is waiting for your input" }).out, "");
    assert.equal(fs.existsSync(path.join(sb.coord, "sessions", `${SID}.json`)), false);
    n({ notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    assert.match(state(sb).waiting_since, /^\d{4}-/);
    hook(sb, ev({}));
    assert.equal(state(sb).waiting_since, null);
  } finally { sb.cleanup(); }
});

test("outside a launcher session (no HL_SESSION_ID) the hook does nothing", () => {
  const sb = sandbox();
  try {
    const r = hook(sb, ev({}), {});
    assert.equal(r.code, 0); assert.equal(r.out, "");
    assert.equal(fs.existsSync(sb.coord), false);
  } finally { sb.cleanup(); }
});

test("any error or corrupt state: exit 0, no output", () => {
  const sb = sandbox();
  try {
    for (const input of ["{not json", "", "null", "[]"]) { const r = hook(sb, input); assert.equal(r.code, 0, input); assert.equal(r.out, "", input); }
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", `${SID}.json`), "{corrupt");
    fs.writeFileSync(path.join(sb.coord, "looping.json"), "[1,2");
    fs.writeFileSync(path.join(sb.coord, "config.json"), "{bad");
    let r = hook(sb, ev({}));
    assert.equal(r.code, 0); assert.equal(r.out, "");
    r = coordRun(sb, ["post-tool"], { input: ev({}), env: { HL_SESSION_ID: REG_ID, HL_SKILL_DIR: path.join(sb.tmp, "missing") } });
    assert.equal(r.code, 0); assert.equal(r.out, ""); assert.equal(r.err, "");
    r = coordRun(sb, ["notify"], { input: "{x", env: { HL_SESSION_ID: REG_ID } });
    assert.equal(r.code, 0); assert.equal(r.out, "");
    r = coordRun(sb, ["no-such-subcommand"]);
    assert.equal(r.code, 0); assert.equal(r.out, "");
  } finally { sb.cleanup(); }
});

test("corrupt shapes in looping.json and stop files inject nothing; a session id that is not a plain id writes nothing", () => {
  const sb = sandbox();
  try {
    const d = path.join(sb.reg, "stops"), at = new Date().toISOString();
    fs.mkdirSync(d, { recursive: true }); fs.mkdirSync(sb.coord, { recursive: true });
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.ladder.stop.json"), JSON.stringify({ id: REG_ID, token: "l1", at })); // no text
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.close.stop.json"), JSON.stringify({ id: REG_ID, token: "c1", text: { not: "a string" }, at }));
    fs.writeFileSync(path.join(d, "A-2026-01-01T00-00-00-000Z.manual.stop.json"), JSON.stringify({ id: REG_ID, token: 7, text: "BAD TOKEN", at }));
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ [SID]: "not an object" }));
    for (const o of [{}, { agent_id: "0" }]) assert.equal(hook(sb, ev(o)).out, "");
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ [SID]: { ag1: null, ag2: "x", ag3: [1], ag4: { key: 5, text: "k" } } }));
    for (const o of [{}, { agent_id: "ag1" }, { agent_id: "ag2" }, { agent_id: "ag3" }, { agent_id: "ag4" }]) assert.equal(hook(sb, ev(o)).out, "", JSON.stringify(o));
    assert.deepEqual(sb.registry(), []); // nothing marked delivered that was never injected
    for (const sid of ["../escape", "a/b", "..", ""]) {
      for (const sub of ["post-tool", "notify"]) {
        const r = coordRun(sb, [sub], { input: ev({ session_id: sid, notification_type: "permission_prompt" }), env: { HL_SESSION_ID: REG_ID } });
        assert.equal(r.code, 0); assert.equal(r.out, "");
      }
    }
    assert.equal(fs.existsSync(path.join(sb.coord, "escape.json")), false);
    assert.equal(fs.existsSync(path.join(sb.coord, "sessions", "a")), false);
    assert.deepEqual(fs.readdirSync(path.join(sb.coord, "sessions")), [`${SID}.json`]);
  } finally { sb.cleanup(); }
});

test("every launch passes the session hooks with --settings and triggers a tick", () => {
  const sb = sandbox();
  try {
    const out = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high").out);
    const f = path.join(sb.reg, "session-hooks.json").split(path.sep).join("/");
    const i = out.claude_args.indexOf("--settings");
    assert.ok(i >= 0); assert.equal(out.claude_args[i + 1], `'${f}'`);
    const h = JSON.parse(fs.readFileSync(f, "utf8")).hooks;
    assert.equal(h.PostToolUse[0].matcher, "*");
    assert.match(h.PostToolUse[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" post-tool$/);
    assert.match(h.Notification[0].hooks[0].command, /^node ".*claude\/hooks\/coord\.mjs" notify$/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(sb.coord, "tick.json"), "utf8")).by, "launch");
    const bg = JSON.parse(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "opus", "--effort", "high", "--mode", "bg").out.split("\nHL_NO_SPAWN")[0]);
    const j = bg.command.indexOf("--settings");
    assert.deepEqual(bg.command.slice(j, j + 2), ["--settings", f]);
  } finally { sb.cleanup(); }
});

// Every file under dir (forward-slash relative path -> bytes).
function snap(dir) {
  const m = new Map();
  const walk = (d) => {
    let names = []; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else m.set(path.relative(dir, p).split(path.sep).join("/"), fs.readFileSync(p)); }
  };
  walk(dir);
  return m;
}
const changed = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => !a.has(k) || !b.has(k) || !a.get(k).equals(b.get(k))).sort();

test("isolation: a post-tool call writes only this session's state, tick.json and one {stop_delivered} line for this session", () => {
  const sb = sandbox();
  try {
    const OTHER = "99999999-8888-7777-6666-555555555555", stops = path.join(sb.reg, "stops"), regFile = path.join(sb.reg, "sessions.jsonl"), at = new Date().toISOString();
    fs.mkdirSync(path.join(sb.coord, "sessions"), { recursive: true }); fs.mkdirSync(stops, { recursive: true });
    fs.writeFileSync(path.join(sb.coord, "sessions", `${OTHER}.json`), JSON.stringify({ streaks: { main: { key: "Read {}", n: 2 } } }));
    fs.writeFileSync(path.join(sb.coord, "looping.json"), JSON.stringify({ [OTHER]: { ag9: { key: "Bash {}", type: "worker-high", text: "x5", transcript: "/t/agent-ag9.jsonl" } } }));
    fs.writeFileSync(path.join(sb.coord, "config.json"), JSON.stringify({ warn_streak: 3 }));
    fs.writeFileSync(path.join(sb.coord, "tick.json"), JSON.stringify({ at: "2026-01-01T00:00:00.000Z", by: "launch" }));
    fs.writeFileSync(path.join(stops, "B-2026-01-01T00-00-00-000Z.manual.stop.json"), JSON.stringify({ id: "B@2026-01-01T00-00-00-000Z", token: "other", text: "NOT YOURS", at }));
    fs.writeFileSync(regFile, JSON.stringify({ id: REG_ID, name: "A", launched_at: at, coord: 1 }) + "\n");
    const mine = [`sessions/${SID}.json`, "tick.json"];

    // A plain call (another session's stop and looping entry exist): the registry dir is untouched.
    let c0 = snap(sb.coord), r0 = snap(sb.reg);
    const plain = hook(sb, ev({}));
    assert.equal(plain.code, 0); assert.equal(plain.out, "");
    const c1 = changed(c0, snap(sb.coord));
    assert.ok(c1.includes(`sessions/${SID}.json`), "this session's state is written");
    assert.deepEqual(c1.filter((k) => !mine.includes(k)), []);
    assert.deepEqual(changed(r0, snap(sb.reg)), []);

    // A call that delivers this session's stop: exactly one appended {stop_delivered} line, the stop file unchanged.
    fs.writeFileSync(path.join(stops, "A-2026-01-01T00-00-00-000Z.manual.stop.json"), JSON.stringify({ id: REG_ID, token: "mine", text: "STOP A", at }));
    c0 = snap(sb.coord); r0 = snap(sb.reg);
    const before = fs.readFileSync(regFile, "utf8");
    assert.equal(ctxOf(hook(sb, ev({ tool_input: { file_path: "b" } }))), "STOP A");
    assert.deepEqual(changed(c0, snap(sb.coord)).filter((k) => !mine.includes(k)), []);
    assert.deepEqual(changed(r0, snap(sb.reg)), ["sessions.jsonl"]);
    const after = fs.readFileSync(regFile, "utf8");
    assert.ok(after.startsWith(before));
    const added = after.slice(before.length).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(added.length, 1);
    assert.deepEqual(Object.keys(added[0]).sort(), ["at", "stop_delivered", "token"]);
    assert.equal(added[0].stop_delivered, REG_ID); assert.equal(added[0].token, "mine");
  } finally { sb.cleanup(); }
});

test("launch.mjs stop writes a stop file that carries at; the hook delivers it at the next tool call", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--name", "A", "--model", "opus", "--effort", "high").code, 0);
    const e = sb.registry().find((o) => o.name === "A" && o.launched_at);
    assert.equal(sb.run("stop", "--name", "A", "--why", "test").code, 0);
    const files = fs.readdirSync(path.join(sb.reg, "stops"));
    assert.equal(files.length, 1); assert.match(files[0], /\.manual\.stop\.json$/);
    const st = JSON.parse(fs.readFileSync(path.join(sb.reg, "stops", files[0]), "utf8"));
    assert.match(st.at, /^\d{4}-\d\d-\d\dT/);
    assert.ok(Math.abs(Date.parse(st.at) - Date.now()) < 5 * 60000, "at is the request time");
    assert.equal(ctxOf(hook(sb, ev({}), { HL_SESSION_ID: e.id })), st.text);
    assert.ok(sb.registry().some((o) => o.stop_delivered === e.id && o.token === st.token));
  } finally { sb.cleanup(); }
});
