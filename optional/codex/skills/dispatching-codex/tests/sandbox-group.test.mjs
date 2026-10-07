// I2: the read check runs as the offline sandbox user only; the network sandbox user (CodexSandboxOnline) is covered
// by checking that BOTH sandbox accounts are members of CodexSandboxUsers (the group the read-deny ACEs name).
// net.exe is injected with fixture outputs; the real one runs once and only has to return a result object.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { sandboxGroupCheck, netRun } from "../lib/readcheck.mjs";

const out = (members, code = 0) => async () => ({
  code,
  stdout: [
    "Alias name     CodexSandboxUsers", "Comment        Codex sandbox internal group (managed)", "", "Members", "",
    "-------------------------------------------------------------------------------", ...members,
    "The command completed successfully.", "", "",
  ].join("\r\n"),
  stderr: "",
  error: null,
});

test("sandboxGroupCheck: both members present (bare and DOMAIN\\ spellings, any case) -> ok", async () => {
  assert.deepEqual(await sandboxGroupCheck({ run: out(["CodexSandboxOffline", "CodexSandboxOnline"]) }), { ok: true });
  assert.deepEqual(await sandboxGroupCheck({ run: out(["HOST\\CodexSandboxOffline", "HOST\\codexsandboxonline"]) }), { ok: true });
});

test("sandboxGroupCheck: runs System32\\net.exe localgroup CodexSandboxUsers", async () => {
  let seen;
  await sandboxGroupCheck({ run: async (exe, args) => { seen = { exe, args }; return out(["CodexSandboxOffline", "CodexSandboxOnline"])(); } });
  assert.equal(path.basename(seen.exe).toLowerCase(), "net.exe");
  assert.equal(path.basename(path.dirname(seen.exe)).toLowerCase(), "system32");
  assert.deepEqual(seen.args, ["localgroup", "CodexSandboxUsers"]);
});

test("sandboxGroupCheck: Online missing -> read-boundary-open naming the user", async () => {
  assert.deepEqual(await sandboxGroupCheck({ run: out(["CodexSandboxOffline"]) }),
    { ok: false, reason: "read-boundary-open: CodexSandboxOnline not in CodexSandboxUsers" });
});

test("sandboxGroupCheck: Offline missing -> read-boundary-open naming the user", async () => {
  assert.deepEqual(await sandboxGroupCheck({ run: out(["HOST\\CodexSandboxOnline", "someone"]) }),
    { ok: false, reason: "read-boundary-open: CodexSandboxOffline not in CodexSandboxUsers" });
});

test("sandboxGroupCheck: look-alike names do not count", async () => {
  const r = await sandboxGroupCheck({ run: out(["CodexSandboxOnlineX", "NotCodexSandboxOffline", "HOST\\CodexSandboxUsers"]) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^read-boundary-open: CodexSandboxOffline not in CodexSandboxUsers$/);
});

test("sandboxGroupCheck: localized or garbage output fails closed", async () => {
  const localized = async () => ({
    code: 0, error: null, stderr: "",
    stdout: "Aliasname      CodexSandboxUsers\r\nMitglieder\r\n\r\n-----\r\nDer Befehl wurde erfolgreich ausgeführt.\r\n",
  });
  const garbage = async () => ({ code: 0, error: null, stderr: "", stdout: "\u0000\u0001 not a group listing <html>" });
  const empty = async () => ({ code: 0, error: null, stderr: "", stdout: "" });
  for (const run of [localized, garbage, empty]) {
    const r = await sandboxGroupCheck({ run });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^(read-boundary-open|read-check-failed)/);
  }
});

test("sandboxGroupCheck: a non-zero exit, a launch error or a throwing runner -> read-check-failed", async () => {
  const nonzero = await sandboxGroupCheck({ run: out(["CodexSandboxOffline", "CodexSandboxOnline"], 2) });
  assert.equal(nonzero.ok, false);
  assert.match(nonzero.reason, /^read-check-failed: /);
  const launch = await sandboxGroupCheck({ run: async () => ({ code: null, error: "spawn ENOENT", stdout: "", stderr: "" }) });
  assert.equal(launch.ok, false);
  assert.match(launch.reason, /^read-check-failed: .*ENOENT/);
  const thrown = await sandboxGroupCheck({ run: async () => { throw new Error("boom"); } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /^read-check-failed: .*boom/);
});

test("sandboxGroupCheck: the real net.exe runs and returns a result object (membership is machine-specific)", async () => {
  const r = await sandboxGroupCheck();
  assert.equal(typeof r, "object");
  assert.equal(typeof r.ok, "boolean");
  if (!r.ok) assert.match(r.reason, /^(read-boundary-open|read-check-failed)/);
});

// M2: CODEX_RUN_NET_FIXTURE acts only inside a node --test process (NODE_TEST_CONTEXT set). The real runner is
// observed through the injectable `proc`; net.exe is never run here.
function fixtureFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "net-fx-"));
  const f = path.join(d, "fx.json");
  fs.writeFileSync(f, JSON.stringify({ code: 0, stdout: "FIXTURE" }));
  return { f, done: () => fs.rmSync(d, { recursive: true, force: true }) };
}
const fakeProc = () => { const calls = []; return { calls, proc: async (exe, args) => { calls.push([exe, args]); return { code: 0, stdout: "REAL", stderr: "", error: null }; } }; };

test("M2: fixture variable without NODE_TEST_CONTEXT -> the real runner is chosen, the fixture ignored", async () => {
  const fx = fixtureFile();
  try {
    const p = fakeProc();
    const r = await netRun("net.exe", ["localgroup", "CodexSandboxUsers"], { env: { CODEX_RUN_NET_FIXTURE: fx.f }, proc: p.proc });
    assert.equal(r.stdout, "REAL");
    assert.equal(p.calls.length, 1);
    assert.deepEqual(p.calls[0], ["net.exe", ["localgroup", "CodexSandboxUsers"]]);
  } finally { fx.done(); }
});

test("M2: fixture variable with NODE_TEST_CONTEXT -> the fixture is used, the runner is not", async () => {
  const fx = fixtureFile();
  try {
    const p = fakeProc();
    const r = await netRun("net.exe", [], { env: { CODEX_RUN_NET_FIXTURE: fx.f, NODE_TEST_CONTEXT: "child-v8" }, proc: p.proc });
    assert.equal(r.stdout, "FIXTURE");
    assert.equal(p.calls.length, 0);
  } finally { fx.done(); }
});
