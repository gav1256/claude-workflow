import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { mcEnv, withEnv } from "./mc-helpers.mjs";
import { acquireInstance, releaseInstance, readInstance } from "../instance.mjs";
import { stateDir } from "../paths.mjs";

async function inSandbox(fn) {
  const env = mcEnv();
  try { await withEnv(env, () => fn(env)); } finally { env.cleanup(); }
}
const instFile = () => path.join(stateDir(), "instance.json");

test("M1 the first acquire holds the pipe and writes instance.json {pid, started_at}", () => inSandbox(async (env) => {
  const a = await acquireInstance(env.MC_PIPE_NAME);
  try {
    assert.ok(a.server && !a.taken);
    const o = JSON.parse(fs.readFileSync(instFile(), "utf8"));
    assert.equal(o.pid, process.pid);
    assert.ok(Date.parse(o.started_at) > 0);
    assert.deepEqual(readInstance(), o);
  } finally { await releaseInstance(a.server); }
}));

test("M1 a second acquire is refused with the holder's pid and time, and the first holder is unaffected", () => inSandbox(async (env) => {
  const a = await acquireInstance(env.MC_PIPE_NAME);
  try {
    const before = fs.readFileSync(instFile(), "utf8");
    const b = await acquireInstance(env.MC_PIPE_NAME);
    assert.equal(b.server, undefined);
    assert.equal(b.taken.pid, process.pid);
    assert.equal(b.taken.started_at, JSON.parse(before).started_at);
    assert.equal(fs.readFileSync(instFile(), "utf8"), before, "the loser never rewrites instance.json");
    assert.equal(a.server.listening, true, "the first server still listens");
    // and it still accepts a connection
    await new Promise((resolve, reject) => {
      const c = net.connect(`\\\\.\\pipe\\${env.MC_PIPE_NAME}`, () => { c.end(); resolve(); });
      c.on("error", reject);
    });
  } finally { await releaseInstance(a.server); }
}));

test("a taken pipe with no readable instance.json gives taken: null (the pipe decides, not the file)", () => inSandbox(async (env) => {
  const holder = net.createServer();
  await new Promise((r) => holder.listen(`\\\\.\\pipe\\${env.MC_PIPE_NAME}`, r));
  try {
    assert.deepEqual(await acquireInstance(env.MC_PIPE_NAME), { taken: null });
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(instFile(), "not json");
    assert.deepEqual(await acquireInstance(env.MC_PIPE_NAME), { taken: null });
    fs.writeFileSync(instFile(), JSON.stringify({ pid: "x", started_at: 5 }));
    assert.deepEqual(await acquireInstance(env.MC_PIPE_NAME), { taken: null }, "a wrong shape is not used");
  } finally { await new Promise((r) => holder.close(r)); }
}));

test("a stale instance.json never blocks a start, and a release frees the name", () => inSandbox(async (env) => {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(instFile(), JSON.stringify({ pid: 999999, started_at: "2020-01-01T00:00:00.000Z" }));
  const a = await acquireInstance(env.MC_PIPE_NAME);
  assert.ok(a.server);
  assert.equal(readInstance().pid, process.pid, "the new holder replaced the stale record");
  await releaseInstance(a.server);
  const b = await acquireInstance(env.MC_PIPE_NAME);
  assert.ok(b.server, "free again after the release");
  await releaseInstance(b.server);
  await releaseInstance(null); // a null server is fine
}));

test("two acquires racing at once: exactly one wins", () => inSandbox(async (env) => {
  const rs = await Promise.all([acquireInstance(env.MC_PIPE_NAME), acquireInstance(env.MC_PIPE_NAME), acquireInstance(env.MC_PIPE_NAME)]);
  try {
    assert.equal(rs.filter((r) => r.server).length, 1);
    assert.equal(rs.filter((r) => "taken" in r).length, 2);
  } finally { for (const r of rs) await releaseInstance(r.server); }
}));

test("the default name comes from MC_PIPE_NAME", () => inSandbox(async (env) => {
  const a = await acquireInstance();
  try {
    assert.ok(a.server);
    assert.ok((await acquireInstance(env.MC_PIPE_NAME)).taken, "the env name is the one held");
  } finally { await releaseInstance(a.server); }
}));
