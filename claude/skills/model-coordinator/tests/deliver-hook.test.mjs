import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { SKILL_DIR, withEnv, importFresh } from "./mc-helpers.mjs";
import { msgKey } from "../paths.mjs";
import { sandbox, sessionLine } from "../../handoff-launch/tests/helpers.mjs";
import { sessionHooks, MC_DELIVER, COORD_MJS } from "../../handoff-launch/live.mjs";

const HOOK = path.join(SKILL_DIR, "deliver-hook.mjs");
const LANE = "w-01";
const hex = (n) => n.toString(16).padStart(32, "0");
const state = (sb) => path.join(sb.cfg, "state", "model-coordinator");
const folder = (sb) => path.join(state(sb), "messages", msgKey(LANE));
const list = (sb) => { try { return fs.readdirSync(folder(sb)).sort(); } catch { return []; } };
const pending = (sb) => list(sb).filter((f) => !f.endsWith(".delivered.json"));
const delivered = (sb) => list(sb).filter((f) => f.endsWith(".delivered.json"));

/** A sandbox with one lane in the registry; `queue(sb, [[n, text]...])` writes pending messages through store.mjs. */
function lane(sb) { return sessionLine(sb, { name: LANE, mode: "bg", bg_id: "b1", sid: "s1" }); }
async function queue(sb, items) {
  await withEnv(sb.env, async () => {
    const S = await importFresh("store.mjs");
    for (const [n, text, at] of items) S.writeNew(`messages/${msgKey(LANE)}/${hex(n)}.json`, JSON.stringify({ request_id: hex(n), text, at: at ?? new Date(1_700_000_000_000 + n * 1000).toISOString() }));
  });
}
const input = (event = "PostToolUse") => JSON.stringify({ hook_event_name: event, session_id: "x", tool_name: "Bash" });
function hook(sb, { event = "PostToolUse", sid, stdin } = {}) {
  const env = { ...sb.env };
  if (sid === undefined) env.HL_SESSION_ID = "w-01@1"; else if (sid === null) delete env.HL_SESSION_ID; else env.HL_SESSION_ID = sid;
  const r = spawnSync(process.execPath, [HOOK], { env, input: stdin ?? input(event), encoding: "utf8", timeout: 30000, windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const withSb = (fn) => async () => { const sb = sandbox(); try { lane(sb); await fn(sb); } finally { sb.cleanup(); } };

test("M8 two pending messages are delivered in one JSON and claimed; a second run prints nothing", withSb(async (sb) => {
  await queue(sb, [[1, "first thing"], [2, "second thing"]]);
  const r = hook(sb);
  assert.equal(r.code, 0);
  const o = JSON.parse(r.out);
  assert.equal(o.hookSpecificOutput.hookEventName, "PostToolUse");
  const ctx = o.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(`Message from the user, relayed by the coordinator (request ${hex(1)}): first thing`));
  assert.ok(ctx.includes(`(request ${hex(2)}): second thing`));
  assert.ok(ctx.indexOf("first thing") < ctx.indexOf("second thing"), "oldest first");
  assert.deepEqual(pending(sb), []);
  assert.deepEqual(delivered(sb), [`${hex(1)}.delivered.json`, `${hex(2)}.delivered.json`]);
  const again = hook(sb);
  assert.equal(again.code, 0);
  assert.equal(again.out, "");
}));

test("M8 the event name is echoed (UserPromptSubmit); other events deliver nothing", withSb(async (sb) => {
  await queue(sb, [[1, "hello"]]);
  assert.equal(hook(sb, { event: "Stop" }).out, "");
  assert.equal(hook(sb, { event: "Notification" }).out, "");
  assert.equal(pending(sb).length, 1);
  assert.equal(JSON.parse(hook(sb, { event: "UserPromptSubmit" }).out).hookSpecificOutput.hookEventName, "UserPromptSubmit");
}));

test("M8 without HL_SESSION_ID (or with an unknown one) it prints nothing, exits 0 and leaves the files", withSb(async (sb) => {
  await queue(sb, [[1, "hello"]]);
  for (const sid of [null, "", "nobody@9"]) {
    const r = hook(sb, { sid });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  }
  assert.equal(pending(sb).length, 1);
}));

test("M8 bad stdin and an absent message folder: exit 0, no output, no state folder created", withSb((sb) => {
  for (const stdin of ["", "not json", "null"]) { const r = hook(sb, { stdin }); assert.equal(r.code, 0); assert.equal(r.out, ""); }
  const r = hook(sb);
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(fs.existsSync(state(sb)), false, "nothing was ever queued: the hook creates nothing");
}));

test("M8 a 20 KiB backlog delivers at most 8 KiB, oldest first, and leaves the rest pending", withSb(async (sb) => {
  await queue(sb, Array.from({ length: 20 }, (_, i) => [i + 1, `msg-${String(i + 1).padStart(2, "0")} ${"x".repeat(1000)}`]));
  const r = hook(sb);
  assert.equal(r.code, 0);
  assert.ok(Buffer.byteLength(r.out) <= 8192, `printed ${Buffer.byteLength(r.out)} bytes`);
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  const got = [...ctx.matchAll(/msg-(\d\d) /g)].map((m) => Number(m[1]));
  assert.ok(got.length >= 5 && got.length < 20, `delivered ${got.length}`);
  assert.deepEqual(got, got.map((_, i) => i + 1), "in order, from the oldest");
  assert.equal(delivered(sb).length, got.length);
  assert.equal(pending(sb).length, 20 - got.length);
  assert.ok(!pending(sb).includes(`${hex(1)}.json`) && pending(sb).includes(`${hex(20)}.json`));
  // the next call takes the next slice
  const r2 = hook(sb);
  assert.ok(JSON.parse(r2.out).hookSpecificOutput.additionalContext.includes(`msg-${String(got.length + 1).padStart(2, "0")} `));
}));

test("M8 one message bigger than 8 KiB is cut, delivered, and its marker names the claimed file that keeps the full text", withSb(async (sb) => {
  const big = "#".repeat(20000);
  await queue(sb, [[1, big], [2, "after"]]);
  const r = hook(sb);
  assert.ok(Buffer.byteLength(r.out) <= 8192);
  const ctx = JSON.parse(r.out).hookSpecificOutput.additionalContext;
  const m = /\[cut: (\d+) more characters; full text in (.+?\.delivered\.json)\]/.exec(ctx);
  assert.ok(m, ctx.slice(-200));
  const file = m[2];
  assert.equal(path.resolve(file), path.resolve(path.join(folder(sb), `${hex(1)}.delivered.json`)));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).text, big, "nothing is lost: the claimed file holds the whole text");
  assert.equal(20000 - Number(m[1]) , ctx.split("#").length - 1, "N counts exactly the characters left out");
  assert.deepEqual(pending(sb), [`${hex(2)}.json`]);
}));

test("M8 a 7000-character message is delivered whole; a 10k one is cut with the path (Claude Code saves hook output over 10,000 characters to disk)", withSb(async (sb) => {
  await queue(sb, [[1, "#".repeat(7000)]]);
  const whole = JSON.parse(hook(sb).out).hookSpecificOutput.additionalContext;
  assert.equal(whole.split("#").length - 1, 7000);
  assert.ok(!whole.includes("[cut:"));
  await queue(sb, [[2, "#".repeat(10000)]]);
  const cut = JSON.parse(hook(sb).out).hookSpecificOutput.additionalContext;
  assert.match(cut, /\[cut: \d+ more characters; full text in .*\.delivered\.json\]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder(sb), `${hex(2)}.delivered.json`), "utf8")).text.length, 10000);
}));

test("H1 a backlog of delivered files never hides a new pending message", withSb(async (sb) => {
  await withEnv(sb.env, async () => {
    const S = await importFresh("store.mjs");
    for (let i = 1; i <= 250; i++) S.writeNew(`messages/${msgKey(LANE)}/${hex(i)}.delivered.json`, "{}");
    S.writeNew(`messages/${msgKey(LANE)}/${"f".repeat(32)}.json`, JSON.stringify({ request_id: "f", text: "still arrives", at: new Date().toISOString() }));
  });
  const r = hook(sb);
  assert.ok(JSON.parse(r.out).hookSpecificOutput.additionalContext.includes("still arrives"));
  assert.deepEqual(pending(sb), []);
}));

test("M8 a message with a missing text or broken JSON is left alone", withSb(async (sb) => {
  await queue(sb, [[1, "good"]]);
  fs.writeFileSync(path.join(folder(sb), `${hex(2)}.json`), "{torn");
  fs.writeFileSync(path.join(folder(sb), `${hex(3)}.json`), JSON.stringify({ request_id: "x" }));
  const r = hook(sb);
  assert.ok(JSON.parse(r.out).hookSpecificOutput.additionalContext.includes("good"));
  assert.deepEqual(pending(sb), [`${hex(2)}.json`, `${hex(3)}.json`]);
}));

test("M8 three hook processes racing deliver each message exactly once", withSb(async (sb) => {
  const N = 12;
  await queue(sb, Array.from({ length: N }, (_, i) => [i + 1, `race-${String(i + 1).padStart(2, "0")}`]));
  const env = { ...sb.env, HL_SESSION_ID: "w-01@1" };
  const one = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = ""; p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(input());
  });
  const results = await Promise.all([one(), one(), one()]);
  assert.ok(results.every((r) => r.code === 0));
  const seen = results.flatMap((r) => (r.out ? [...JSON.parse(r.out).hookSpecificOutput.additionalContext.matchAll(/race-(\d\d)/g)].map((m) => m[1]) : []));
  assert.equal(seen.length, N, `every message once: ${seen.join(",")}`);
  assert.equal(new Set(seen).size, N);
  assert.deepEqual(pending(sb), []);
  assert.equal(delivered(sb).length, N);
}));

test("M9 sessionHooks keeps coord.mjs first in PostToolUse and UserPromptSubmit and adds the delivery hook", () => {
  assert.ok(fs.existsSync(MC_DELIVER), "the delivery hook file exists in this layout");
  assert.equal(path.resolve(MC_DELIVER), path.resolve(HOOK));
  const h = sessionHooks().hooks;
  const cmd = (g) => g.hooks[0].command;
  assert.match(cmd(h.PostToolUse[0]), /claude\/hooks\/coord\.mjs" post-tool$/);
  assert.equal(h.PostToolUse[0].matcher, "*");
  assert.equal(h.PostToolUse.length, 2);
  assert.equal(h.PostToolUse[1].matcher, "*");
  assert.match(cmd(h.PostToolUse[1]), /^node ".*model-coordinator\/deliver-hook\.mjs"$/);
  assert.equal(h.PostToolUse[1].hooks[0].timeout, 5);
  assert.match(cmd(h.UserPromptSubmit[0]), /coord\.mjs" lane-note$/);
  assert.equal(h.UserPromptSubmit.length, 2);
  assert.equal("matcher" in h.UserPromptSubmit[1], false);
  assert.match(cmd(h.UserPromptSubmit[1]), /deliver-hook\.mjs"$/);
  assert.equal(h.UserPromptSubmit[1].hooks[0].type, "command");
  assert.ok(COORD_MJS.endsWith("coord.mjs"));
  assert.ok(!cmd(h.PostToolUse[1]).includes("\\"), "forward slashes in the command");
});
