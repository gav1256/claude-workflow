import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { mcEnv, withEnv, makeRepo, fakeCodexLib, recordingSpawn, sleep, FAKE_CODEX_RUN, FAKE_CODEX_CLI } from "./mc-helpers.mjs";
import { DEFAULTS } from "../config.mjs";
import { stateDir, codexSkillDir } from "../paths.mjs";
import * as store from "../store.mjs";
import { foldWorkers } from "../workers.mjs";
import { createAllowance, createLoginCache } from "../codex-resources.mjs";
import { createCodexAdapter } from "../codex-adapter.mjs";
import { loadCodexLib, assertLibHref } from "../codex-lib.mjs";

const realGit = (args, { cwd } = {}) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true }); return { code: r.status ?? null, stdout: r.stdout || "", stderr: r.stderr || "" }; };
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true }).trim();
const CRED_SEEDS = { Openai_Api_Key: "x", codex_api_key: "x", CODEX_RUN_ENV_ALLOW: "x", HL_SESSION_ID: "lane@1" };

/**
 * One test rig: a temp CFG, a real temp repo, a scenario file for the fake codex-run, and a factory for adapters over the
 * same state folder. `body({env, repo, mk, ad, lib, libState, spawn, allowance, workers, addWorker, scenario, pollUntil, attempts})`.
 */
async function rig(body, { codex = {}, scenario = {}, extraEnv = {}, login = async () => "chatgpt", deps = {}, spawn = recordingSpawn(), libState = {} } = {}) {
  const env = mcEnv({ FAKE_LOGIN: "chatgpt", ...extraEnv });
  try {
    const repo = makeRepo(env.root);
    const scenarioFile = path.join(env.root, "scenario.json");
    const setScenario = (s) => fs.writeFileSync(scenarioFile, JSON.stringify(s));
    setScenario(scenario);
    env.FAKE_RUN_SCENARIO = scenarioFile;
    return await withEnv(env, async () => {
      const cfg = { ...structuredClone(DEFAULTS), codex: { ...DEFAULTS.codex, ...codex } };
      const lib = fakeCodexLib(libState);
      const allowance = createAllowance(cfg.codex.max_parallel_jobs);
      const mk = (o = {}) => createCodexAdapter({
        cfg, repo: "repo" in o ? o.repo : repo, lib: "lib" in o ? o.lib : lib, allowance: o.allowance ?? allowance, login: "login" in o ? o.login : login,
        deps: { spawn, codexRunPath: FAKE_CODEX_RUN, requeueDelayMs: 0, ...deps, ...(o.deps ?? {}) },
      });
      const ad = mk();
      const workers = () => foldWorkers(store.readJsonl("workers"));
      const addWorker = (id, extra = {}) => {
        store.appendJsonl("workers", { ev: "created", id, provider: "codex", label: id.replace(/-\d+$/, ""), objective: `Objective of ${id}`, repo, created_at: new Date().toISOString(), ...extra });
        return workers().get(id);
      };
      const attempts = () => store.readJsonl("codex-attempts");
      const pollUntil = async (cond, { ms = 30000, adapter = ad } = {}) => {
        const t0 = Date.now(), events = [];
        for (;;) {
          events.push(...await adapter.poll());
          if (cond(events)) return events;
          if (Date.now() - t0 > ms) throw new Error(`pollUntil timed out; attempts: ${JSON.stringify(attempts().map((a) => [a.attempt_id, a.state]))}`);
          await sleep(100);
        }
      };
      return await body({ env, repo, mk, ad, lib, libState, spawn, allowance, workers, addWorker, setScenario, pollUntil, attempts, cfg });
    });
  } finally {
    for (const c of spawn.children ?? []) { try { c.kill(); } catch { /* already gone */ } }
    await sleep(200);
    env.cleanup();
  }
}

test("M1 ensureWorktree creates a linked worktree on codex-<id>; a second call is a no-op; a foreign path is refused", () => rig(async ({ ad, repo, addWorker }) => {
  const w = addWorker("auth-01");
  const r = ad.ensureWorktree(w);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.branch, "codex-auth-01");
  assert.equal(path.resolve(r.worktree), path.resolve(repo, ".claude", "worktrees", "codex-auth-01"));
  assert.equal(git(r.worktree, "rev-parse", "--abbrev-ref", "HEAD"), "codex-auth-01");
  assert.notEqual(git(r.worktree, "rev-parse", "--git-dir"), git(r.worktree, "rev-parse", "--git-common-dir"), "a linked worktree has its own git dir");
  assert.equal(git(r.worktree, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"), "created from HEAD");
  const again = ad.ensureWorktree(w);
  assert.deepEqual(again, r);
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 2, "no second worktree");

  // a plain folder at another worker's path
  const w2 = addWorker("auth-02");
  fs.mkdirSync(path.join(repo, ".claude", "worktrees", "codex-auth-02"), { recursive: true });
  const bad = ad.ensureWorktree(w2);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not this worker's|exists/);
  // a real worktree at the path, but on another branch
  const w3 = addWorker("auth-03");
  git(repo, "worktree", "add", "-b", "other-branch", path.join(repo, ".claude", "worktrees", "codex-auth-03"), "HEAD");
  const bad3 = ad.ensureWorktree(w3);
  assert.equal(bad3.ok, false);
  // an id that cannot be a path component
  assert.equal(ad.ensureWorktree({ id: "../evil" }).ok, false);
}));

test("M2 start spawns once: detached, windowsHide, stdio to the out file, stripped env; reserved then spawned; poll gives waiting_for_user", () => rig(async ({ ad, spawn, addWorker, workers, attempts, allowance, pollUntil, repo }) => {
  assert.equal(process.env.Openai_Api_Key, "x", "the seeds are really in process.env");
  assert.equal(process.env.HL_SESSION_ID, "lane@1");
  const w = addWorker("auth-01");
  const out = await ad.start(w, "Add the login check", { requestId: "r1" });
  assert.deepEqual(Object.keys(out), ["started"]);
  assert.equal(out.started, "auth-01.1");
  assert.equal(allowance.active(), 1);
  assert.equal(spawn.calls.length, 1);
  const c = spawn.calls[0];
  assert.equal(c.cmd, process.execPath);
  assert.equal(c.opts.detached, true);
  assert.equal(c.opts.windowsHide, true);
  assert.equal(c.opts.stdio[0], "ignore");
  assert.equal(typeof c.opts.stdio[1], "number");
  assert.equal(typeof c.opts.stdio[2], "number");
  const a = c.args;
  assert.equal(a[0], FAKE_CODEX_RUN);
  const arg = (k) => a[a.indexOf(k) + 1];
  assert.equal(arg("--mode"), "write");
  assert.equal(arg("--model"), "sol");
  assert.equal(arg("--effort"), "medium");
  assert.equal(arg("--task"), "auth-01.1");
  assert.equal(path.resolve(arg("--cwd")), path.resolve(repo, ".claude", "worktrees", "codex-auth-01"));
  assert.ok(!a.includes("--continue"));
  assert.equal(path.resolve(arg("--brief")), path.resolve(stateDir(), "briefs", "auth-01.1.md"));
  for (const k of Object.keys(c.opts.env)) {
    const u = k.toUpperCase();
    assert.ok(!["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_RUN_ENV_ALLOW"].includes(u), `credential in spawn env: ${k}`);
    assert.ok(!u.startsWith("HL_"), `HL_ in spawn env: ${k}`);
  }
  assert.ok(c.opts.env.CLAUDE_CONFIG_DIR, "CLAUDE_CONFIG_DIR is kept");

  const lines = attempts().filter((l) => l.attempt_id === "auth-01.1");
  assert.deepEqual(lines.map((l) => l.state), ["reserved", "spawned"]);
  assert.equal(lines[0].request_id, "r1");
  assert.equal(lines[0].head_before, git(repo, "rev-parse", "HEAD"));
  assert.equal(lines[0].out, "codex-out/auth-01.1.out");
  assert.ok(Number.isInteger(lines[1].pid) && lines[1].pid > 0);

  // the brief follows the Codex write template
  const brief = fs.readFileSync(path.join(stateDir(), "briefs", "auth-01.1.md"), "utf8");
  assert.match(brief, /^# Task auth-01\.1: auth$/m);
  assert.match(brief, /^Goal: Objective of auth-01$/m);
  assert.match(brief, /^New instruction: Add the login check$/m);
  assert.match(brief, /^Files you own: `\*\*`$/m);
  assert.match(brief, /^Do not create or edit anything else\.$/m);
  assert.match(brief, /^Builds on: [0-9a-f]{40}$/m);
  assert.match(brief, /^Done when: the new instruction is done; report what changed$/m);
  assert.match(brief, /^Constraints: never commit; never touch files outside this worktree; fake data uses \.\.\.@example\.com$/m);

  // the worker is running
  assert.equal(workers().get("auth-01").status, "running");
  assert.equal(ad.status(workers().get("auth-01")).status, "running");
  const evs = store.readJsonl("workers").filter((e) => e.ev === "status");
  assert.ok(evs.length && evs.every((e) => !Number.isNaN(Date.parse(e.at))), "every status event carries at");
  return pollUntil((e) => e.some((x) => x.type === "finished"));
}, {
  scenario: { files: { "src/login.js": "export const ok = 1;\n" }, codex_note: "added the login check" },
  extraEnv: CRED_SEEDS,
}));

test("M2 after the fake ends poll sets waiting_for_user with files_changed, releases the reservation, and the fake saw no credentials", () => rig(async ({ ad, addWorker, workers, attempts, allowance, pollUntil, env }) => {
  const dump = path.join(env.root, "env-dump.txt");
  process.env.FAKE_ENV_DUMP = dump;
  const w = addWorker("auth-01");
  await ad.start(w, "Add the login check", { requestId: "r1" });
  const events = await pollUntil((e) => e.some((x) => x.type === "finished"));
  const fin = events.find((x) => x.type === "finished");
  assert.equal(fin.worker_id, "auth-01");
  assert.equal(fin.state, "done");
  const wk = workers().get("auth-01");
  assert.equal(wk.status, "waiting_for_user");
  assert.deepEqual(wk.files_changed, ["src/login.js"]);
  assert.equal(wk.last_result, "added the login check");
  assert.deepEqual(wk.blockers, []);
  assert.equal(allowance.active(), 0);
  const last = attempts().filter((l) => l.attempt_id === "auth-01.1").at(-1);
  assert.equal(last.state, "done");
  assert.ok(last.run_id);
  assert.deepEqual(last.result.files, ["src/login.js"]);
  assert.ok(fs.existsSync(path.join(env.dirs.cfg, "state", "codex", "runs.jsonl")), "the fake appended its ledger line");
  assert.equal(fs.readFileSync(path.join(stateDir(), "codex-out", "auth-01.1.out"), "utf8").trim().split("\n").length, 1);
  const names = fs.readFileSync(dump, "utf8").split("\n").filter(Boolean).map((n) => n.toLowerCase());
  assert.ok(names.length > 3);
  for (const n of names) {
    assert.ok(!["openai_api_key", "codex_api_key", "codex_run_env_allow"].includes(n), n);
    assert.ok(!n.startsWith("hl_"), n);
  }
  // done is not a finished-worker status: no finished_at
  assert.equal(wk.finished_at, null);
}, { scenario: { files: { "src/login.js": "x\n" }, codex_note: "added the login check" }, extraEnv: CRED_SEEDS }));

test("M3 a failed worker run gives status failed and releases the reservation", () => rig(async ({ ad, addWorker, workers, allowance, pollUntil, attempts }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "do it", { requestId: "r1" });
  assert.equal(allowance.active(), 1);
  const events = await pollUntil((e) => e.some((x) => x.type === "finished"));
  assert.equal(events.find((x) => x.type === "finished").state, "failed");
  assert.equal(workers().get("auth-01").status, "failed");
  assert.deepEqual(workers().get("auth-01").blockers, ["codex-exit 1"]);
  assert.equal(allowance.active(), 0);
  assert.equal(attempts().filter((l) => l.attempt_id === "auth-01.1").at(-1).state, "failed");
}, { scenario: { status: "failed", reason: "codex-exit 1" } }));

test("M3 a done run with a failed check lists it as a blocker", () => rig(async ({ ad, addWorker, workers, pollUntil }) => {
  await ad.start(addWorker("auth-01"), "do it", { requestId: "r1" });
  await pollUntil((e) => e.some((x) => x.type === "finished"));
  const wk = workers().get("auth-01");
  assert.equal(wk.status, "waiting_for_user");
  assert.equal(wk.blockers.length, 1);
  assert.match(wk.blockers[0], /npm test.*exit 2/);
}, { scenario: { checks: [{ cmd: "npm test", exit: 2, tail: "1 failing" }, { cmd: "lint", exit: 0, tail: "" }] } }));

test("M4 Codex busy: the second worker is queued and holds no slot; poll starts it after the first ends, rechecking the gate", () => rig(async ({ ad, spawn, addWorker, workers, allowance, pollUntil, attempts, libState }) => {
  const a = addWorker("auth-01"), b = addWorker("docs-01");
  const o1 = await ad.start(a, "first", { requestId: "r1" });
  assert.equal(o1.started, "auth-01.1");
  const o2 = await ad.start(b, "second", { requestId: "r2" });
  assert.deepEqual(Object.keys(o2), ["queued"]);
  assert.equal(o2.queued, "docs-01.1");
  assert.equal(allowance.active(), 1, "the queued job holds no slot");
  assert.equal(spawn.calls.length, 1, "no second spawn");
  assert.equal(workers().get("docs-01").status, "queued");
  assert.equal(ad.status(workers().get("docs-01")).status, "queued");
  // the first run is not touched while the second waits
  assert.equal(attempts().filter((l) => l.attempt_id === "auth-01.1").at(-1).state, "spawned");
  assert.equal(workers().get("auth-01").status, "running");

  // wait for the first to end; hold the gate shut with busy machine slots: the queued job must stay queued
  libState.busy = 3;
  const first = await pollUntil((e) => e.some((x) => x.type === "finished" && x.worker_id === "auth-01"));
  assert.ok(!first.some((x) => x.type === "started"), "gate shut: nothing started");
  assert.equal(spawn.calls.length, 1);
  assert.equal(attempts().filter((l) => l.attempt_id === "docs-01.1").at(-1).state, "queued");
  const before = libState.calls.busySlots;
  await ad.poll();
  assert.ok(libState.calls.busySlots > before, "the gate is checked again on every drain");
  // open it: the queued job starts
  libState.busy = 0;
  const events = await pollUntil((e) => e.some((x) => x.type === "finished" && x.worker_id === "docs-01"));
  assert.ok(events.some((x) => x.type === "started" && x.worker_id === "docs-01"));
  assert.equal(spawn.calls.length, 2);
  assert.equal(workers().get("docs-01").status, "waiting_for_user");
  assert.equal(allowance.active(), 0);
  assert.deepEqual(attempts().filter((l) => l.attempt_id === "docs-01.1").map((l) => l.state), ["queued", "reserved", "spawned", "done"]);
}, { codex: { max_parallel_jobs: 1 }, scenario: { tasks: { "auth-01.1": { delay_ms: 1500 } } } }));

test("M4 a full queue falls back by policy: a new worker gets the Claude fallback, with fallback refuse a refusal", async () => {
  for (const [fb, action] of [["claude", "claude"], ["refuse", "refuse"]]) {
    await rig(async ({ ad, addWorker, allowance, attempts }) => {
      await ad.start(addWorker("a-01"), "x", { requestId: "r1" });
      const q = await ad.start(addWorker("b-01"), "x", { requestId: "r2" });
      assert.ok(q.queued);
      const full = await ad.start(addWorker("c-01"), "x", { requestId: "r3" });
      assert.equal(full.blocked, "busy");
      assert.equal(full.fallback.action, action);
      assert.equal(attempts().filter((l) => l.worker_id === "c-01").length, 0, "no attempt line for a gate block");
      assert.equal(allowance.active(), 1);
    }, { codex: { max_parallel_jobs: 1, queue_max: 1, fallback: fb }, scenario: { delay_ms: 2500 } });
  }
});

test("M5 quarantine: the hint is in the blockers and no --clear-quarantine is ever spawned", () => rig(async ({ ad, spawn, addWorker, workers, pollUntil, attempts, allowance }) => {
  await ad.start(addWorker("auth-01"), "do it", { requestId: "r1" });
  const events = await pollUntil((e) => e.some((x) => x.type === "finished"));
  assert.equal(events.find((x) => x.type === "finished").state, "blocked");
  const wk = workers().get("auth-01");
  assert.equal(wk.status, "blocked");
  assert.ok(wk.blockers.some((b) => b.includes("worktree-quarantined: head-moved")));
  const hint = wk.blockers.find((b) => b.includes("--clear-quarantine"));
  assert.ok(hint, JSON.stringify(wk.blockers));
  assert.ok(hint.includes(`node "${path.join(codexSkillDir() ?? "", "codex-run.mjs")}"`) || codexSkillDir() === null);
  assert.ok(hint.includes(path.join(".claude", "worktrees", "codex-auth-01")));
  assert.equal(ad.quarantineHint("worktree-quarantined: x", "/wt"), `node "${path.join(codexSkillDir(), "codex-run.mjs")}" --clear-quarantine "/wt"`);
  assert.equal(ad.quarantineHint("worktree-busy", "/wt"), null);
  for (const c of spawn.calls) assert.ok(!c.args.some((x) => String(x).includes("clear-quarantine")), "never spawned");
  assert.equal(spawn.calls.length, 1, "a quarantine block is not requeued");
  assert.equal(attempts().filter((l) => l.attempt_id === "auth-01.1").at(-1).state, "blocked");
  assert.equal(allowance.active(), 0);
  // status(worker) reports the same blockers, hint included
  const st = ad.status(wk);
  assert.equal(st.status, "blocked");
  assert.deepEqual(st.blockers, wk.blockers);
  assert.ok(st.blockers.some((b) => b.includes("--clear-quarantine")), JSON.stringify(st.blockers));
}, { scenario: { status: "blocked", reason: "worktree-quarantined: head-moved" } }));

test("M6 no double spawn: same requestId again, after a restart, and while queued", () => rig(async ({ ad, mk, spawn, addWorker, attempts, allowance, pollUntil, workers }) => {
  const w = addWorker("auth-01");
  const first = await ad.start(w, "do it", { requestId: "r1" });
  const second = await ad.start(w, "do it", { requestId: "r1" });
  assert.equal(second.started, first.started);
  assert.equal(second.existing, true);
  assert.equal(spawn.calls.length, 1);
  // a restart: a fresh adapter (and a fresh allowance) over the same state folder
  const ad2 = mk({ allowance: createAllowance(1) });
  const third = await ad2.start(w, "do it", { requestId: "r1" });
  assert.equal(third.started, first.started);
  assert.equal(third.existing, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(attempts().filter((l) => l.request_id === "r1" && l.state === "reserved").length, 1);
  assert.deepEqual(ad.attemptsByRequest("r1").map((a) => a.attempt_id), ["auth-01.1"]);
  assert.deepEqual(ad.attemptsByRequest("nope"), []);

  // a request that is still queued
  const b = addWorker("docs-01");
  const q1 = await ad.start(b, "queue me", { requestId: "r2" });
  assert.ok(q1.queued);
  const q2 = await ad.start(b, "queue me", { requestId: "r2" });
  assert.equal(q2.queued, q1.queued);
  assert.equal(q2.existing, true);
  const q3 = await mk({ allowance: createAllowance(1) }).start(b, "queue me", { requestId: "r2" });
  assert.equal(q3.queued, q1.queued);
  assert.equal(q3.existing, true);
  assert.equal(attempts().filter((l) => l.request_id === "r2").length, 1, "one queued line");
  assert.equal(spawn.calls.length, 1);

  // after it finished, the same request still answers with the attempt, not a new run
  await pollUntil((e) => e.some((x) => x.type === "finished" && x.worker_id === "docs-01"));
  const done = await ad.start(w, "do it", { requestId: "r1" });
  assert.equal(done.existing, true);
  assert.equal(done.started, "auth-01.1");
  assert.equal(done.state, "done");
  assert.equal(spawn.calls.length, 2);
  assert.equal(workers().get("auth-01").status, "waiting_for_user");
}, { codex: { max_parallel_jobs: 1 }, scenario: { tasks: { "auth-01.1": { delay_ms: 600 } } } }));

test("a concurrent pair of identical requests spawns once", () => rig(async ({ ad, spawn, addWorker }) => {
  const w = addWorker("auth-01");
  const [x, y] = await Promise.all([ad.start(w, "do it", { requestId: "r1" }), ad.start(w, "do it", { requestId: "r1" })]);
  assert.equal(x.started, y.started);
  assert.equal([x, y].filter((o) => o.existing).length, 1);
  assert.equal(spawn.calls.length, 1);
}));

test("carried: login is re-checked bypassing the cache right before the spawn", () => rig(async ({ mk, spawn, addWorker, allowance, attempts, workers }) => {
  // the probe says chatgpt once, then api_key: the 5-minute cache alone would keep saying chatgpt
  let probes = 0;
  const cache = createLoginCache(async () => (++probes === 1 ? "chatgpt" : "api_key"), 300000);
  const out = await mk({ login: cache }).start(addWorker("auth-01"), "do it", { requestId: "r1" });
  assert.equal(out.blocked, "unavailable");
  assert.equal(out.reason, "codex-login-api_key");
  assert.ok(out.fallback && out.fallback.action);
  assert.equal(probes, 2, "the gate's probe, then the fresh probe");
  assert.equal(spawn.calls.length, 0);
  assert.equal(allowance.active(), 0);
  assert.equal(attempts().length, 0, "no attempt line: a retry reaches the gate again");
  assert.equal(workers().get("auth-01").status, "starting");
}));

test("carried: a plain injected login function is asked again too", () => rig(async ({ ad, spawn, addWorker }) => {
  const out = await ad.start(addWorker("auth-01"), "do it", { requestId: "r1" });
  assert.equal(out.blocked, "unavailable");
  assert.equal(spawn.calls.length, 0);
}, { login: (() => { let n = 0; return async () => (++n === 1 ? "chatgpt" : "none"); })() }));

test("carried: with no login injected the adapter probes the fake CLI through the real spawnSync, and 'Logged in using ChatGPT' gets through", () => rig(async ({ mk, spawn, addWorker, allowance, pollUntil, workers }) => {
  const ad = mk({ login: null }); // null: the adapter builds its own cached probe over loginStatus + spawnSync
  const out = await ad.start(addWorker("auth-01"), "do it", { requestId: "r1" });
  assert.equal(out.started, "auth-01.1", JSON.stringify(out));
  assert.equal(spawn.calls.length, 1);
  await pollUntil((e) => e.some((x) => x.type === "finished"), { adapter: ad });
  assert.equal(workers().get("auth-01").status, "waiting_for_user");
  assert.equal(allowance.active(), 0);
}));

test("carried: the adapter's own login probe refuses an API-key login (Resolution E)", () => rig(async ({ mk, spawn, addWorker }) => {
  const ad = mk({ login: null });
  const out = await ad.start(addWorker("auth-01"), "do it", { requestId: "r1" });
  assert.equal(out.blocked, "unavailable");
  assert.equal(out.reason, "codex-login-api_key");
  assert.equal(spawn.calls.length, 0);
}, { extraEnv: { FAKE_LOGIN: "api_key" } }));

test("gate blocks: no login is unavailable with a fallback; a workspace conflict asks to clarify", async () => {
  await rig(async ({ mk, addWorker, spawn }) => {
    const out = await mk({ login: null }).start(addWorker("auth-01"), "x", { requestId: "r1" });
    assert.deepEqual([out.blocked, out.reason, out.fallback.action], ["unavailable", "codex-login-none", "claude"]);
    assert.equal(spawn.calls.length, 0);
  }, { extraEnv: { FAKE_LOGIN: "none" } });
  await rig(async ({ ad, repo, addWorker, spawn, attempts }) => {
    fs.mkdirSync(path.join(repo, ".claude", "worktrees", "codex-auth-01"), { recursive: true });
    const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
    assert.ok(out.clarify, JSON.stringify(out));
    assert.equal(spawn.calls.length, 0);
    assert.equal(attempts().length, 0);
  });
});

test("an existing Codex worker is never moved to another provider: refuse", () => rig(async ({ ad, addWorker, pollUntil }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "first", { requestId: "r1" });
  await pollUntil((e) => e.some((x) => x.type === "finished")); // a second request while it runs would queue (Task 10b)
  // the worker now has a finished attempt; make Codex unavailable for its next request
  const out = await ad.start(w, "second", { requestId: "r2" });
  assert.equal(out.blocked, "unavailable");
  assert.equal(out.fallback.action, "refuse");
}, { login: (() => { let n = 0; return async () => (++n <= 2 ? "chatgpt" : "none"); })() }));

test("a spawn that throws blocks the attempt and releases the reservation", () => rig(async ({ ad, addWorker, allowance, attempts, workers }) => {
  const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.blocked, "failed");
  assert.match(out.reason, /boom/);
  assert.ok(out.fallback);
  assert.equal(allowance.active(), 0);
  assert.deepEqual(attempts().map((l) => l.state), ["reserved", "blocked"]);
  assert.equal(workers().get("auth-01").status, "blocked");
  // a retry of the same request answers with the recorded block
  const again = await ad.start(workers().get("auth-01"), "x", { requestId: "r1" });
  assert.equal(again.blocked, "failed");
  assert.equal(again.existing, true);
}, { spawn: recordingSpawn({ fail: "boom" }) }));

test("worktree-busy and codex-slots-full are requeued at most 3 times, then blocked", () => rig(async ({ ad, spawn, addWorker, workers, attempts, allowance, pollUntil }) => {
  await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  const events = await pollUntil((e) => e.some((x) => x.type === "finished"));
  assert.equal(spawn.calls.length, 4, "the first spawn and three respawns");
  assert.equal(events.filter((x) => x.type === "requeued").length, 3);
  const states = attempts().filter((l) => l.attempt_id === "auth-01.1").map((l) => l.state);
  assert.equal(states.filter((s) => s === "queued").length, 3);
  assert.equal(states.at(-1), "blocked");
  assert.equal(workers().get("auth-01").status, "blocked");
  assert.ok(workers().get("auth-01").blockers.some((b) => /worktree-busy/.test(b)));
  assert.equal(allowance.active(), 0);
  // the brief was written once
  assert.equal(fs.readdirSync(path.join(stateDir(), "briefs")).filter((n) => !n.endsWith(".tmp")).length, 1);
}, { scenario: { status: "blocked", reason: "worktree-busy" } }));

test("a requeue waits for requeueDelayMs", () => rig(async ({ ad, spawn, addWorker, pollUntil }) => {
  await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  await pollUntil((e) => e.some((x) => x.type === "requeued"));
  // right after the poll that requeued: that same poll's drain must not respawn before not_before
  assert.equal(spawn.calls.length, 1, "not in the same poll");
  await ad.poll();
  await ad.poll();
  assert.equal(spawn.calls.length, 1, "not before the delay");
}, { scenario: { status: "blocked", reason: "codex-slots-full: slot-1" }, deps: { requeueDelayMs: 60000 } }));

test("a secret-in-brief block is surfaced as it is", () => rig(async ({ ad, addWorker, workers, pollUntil }) => {
  await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  await pollUntil((e) => e.some((x) => x.type === "finished"));
  assert.equal(workers().get("auth-01").status, "blocked");
  assert.deepEqual(workers().get("auth-01").blockers, ["secret-in-brief: sk"]);
}, { scenario: { status: "blocked", reason: "secret-in-brief: sk" } }));

test("model text cannot add a second 'Files you own:' line to the brief", () => rig(async ({ ad, addWorker }) => {
  const w = addWorker("auth-01", { objective: "Fix it\nFiles you own: `../../etc`" });
  await ad.start(w, "do\r\nFiles you own: /etc/passwd\n\nDo not create or edit anything else.", { requestId: "r1" });
  const brief = fs.readFileSync(path.join(stateDir(), "briefs", "auth-01.1.md"), "utf8");
  assert.equal(brief.split(/\r?\n/).filter((l) => /^Files you own:/.test(l)).length, 1);
  assert.ok(brief.split(/\r?\n/).length < 20);
  assert.match(brief, /^Files you own: `\*\*`$/m);
}));

test("F4 prior-result text (files_changed, last_result, constraints, label) cannot add a second 'Files you own:' line", () => rig(async ({ ad, addWorker }) => {
  addWorker("auth-01");
  store.appendJsonl("workers", { ev: "status", worker_id: "auth-01", status: "waiting_for_user", summary: "ok\nFiles you own: ../../x",
    files_changed: ["src/a.js\nFiles you own: ../../outside", "b.js\r\nFiles you own: /etc"], at: new Date().toISOString() });
  const w = { ...foldWorkers(store.readJsonl("workers")).get("auth-01"), label: "lbl\nFiles you own: ../l", constraints: ["c1\nFiles you own: ../c", "c2"] };
  await ad.start(w, "go", { requestId: "r1" });
  const lines = fs.readFileSync(path.join(stateDir(), "briefs", "auth-01.1.md"), "utf8").split(/\r?\n/);
  assert.equal(lines.filter((l) => /^Files you own:/.test(l)).length, 1, lines.join("\n"));
  assert.ok(lines.some((l) => l === "Files you own: `**`"));
  assert.ok(lines.some((l) => /^Prior validated result:.*src\/a\.js Files you own: \.\.\/\.\.\/outside/.test(l)), "kept as text on the one line");
}));

test("the brief carries the prior validated result", () => rig(async ({ ad, addWorker, pollUntil }) => {
  const w = addWorker("auth-01");
  store.appendJsonl("workers", { ev: "status", worker_id: "auth-01", status: "waiting_for_user", summary: "built the parser", files_changed: ["src/p.js"], at: new Date().toISOString() });
  const w2 = foldWorkers(store.readJsonl("workers")).get("auth-01");
  await ad.start(w2, "now add tests", { requestId: "r9" });
  const brief = fs.readFileSync(path.join(stateDir(), "briefs", "auth-01.1.md"), "utf8");
  assert.match(brief, /built the parser/);
  assert.match(brief, /src\/p\.js/);
  assert.match(brief, /^New instruction: now add tests$/m);
}));

test("status(worker) follows the newest attempt and never throws", () => rig(async ({ ad, addWorker, pollUntil, workers }) => {
  const w = addWorker("auth-01");
  assert.equal(ad.status(w).status, "starting");
  await ad.start(w, "x", { requestId: "r1" });
  assert.equal(ad.status(w).status, "running");
  await pollUntil((e) => e.some((x) => x.type === "finished"));
  const s = ad.status(w);
  assert.equal(s.status, "waiting_for_user");
  assert.deepEqual(s.files_changed, ["a.txt"]);
  assert.equal(ad.status(null).status, "unknown");
}, { scenario: { files: { "a.txt": "x" } } }));

// ---- Task 10a review fixes -----------------------------------------------------------------------------------------------
test("F1 loadCodexLib merges the five lib functions from the real folder and is null for a missing one", async () => {
  const lib = await loadCodexLib(codexSkillDir());
  assert.ok(lib, "the repo layout has the dispatching-codex skill");
  for (const k of ["resolveCodex", "busySlots", "latestReading", "mapWindows", "quotaDecision"]) assert.equal(typeof lib[k], "function", k);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-nolib-"));
  try {
    assert.equal(await loadCodexLib(path.join(tmp, "nope")), null);
    assert.equal(await loadCodexLib(tmp), null, "a folder with no lib/ is absent too");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(await loadCodexLib(null), null);
});

test("F1 with no lib injected the adapter loads the real lib (not codex-skill-absent); an explicit null still means absent", () => rig(async ({ mk, addWorker, spawn, pollUntil }) => {
  const absent = await mk({ lib: null }).start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.deepEqual([absent.blocked, absent.reason], ["unavailable", "codex-skill-absent"]);
  const ad = mk({ lib: undefined });
  const out = await ad.start(addWorker("docs-01"), "x", { requestId: "r2" });
  assert.equal(out.started, "docs-01.1", JSON.stringify(out));
  assert.equal(spawn.calls.length, 1);
  await pollUntil((e) => e.some((x) => x.type === "finished"), { adapter: ad });
}, { extraEnv: { CODEX_RUN_BIN: process.execPath, CODEX_RUN_BIN_ARGS: JSON.stringify([FAKE_CODEX_CLI]) } }));

test("F3 an internal-crash line with run: null ends the attempt blocked and frees the slot", () => rig(async ({ ad, addWorker, workers, allowance, attempts, pollUntil }) => {
  await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  const events = await pollUntil((e) => e.some((x) => x.type === "finished"));
  const fin = events.find((x) => x.type === "finished");
  assert.equal(fin.state, "blocked");
  assert.equal(attempts().filter((l) => l.attempt_id === "auth-01.1").at(-1).state, "blocked");
  assert.deepEqual(workers().get("auth-01").blockers, ["internal: boom"]);
  assert.equal(allowance.active(), 0);
}, { scenario: { status: "blocked", reason: "internal: boom", run_null: true } }));

test("F5 a failed reservation write releases the allowance (no leak, nothing spawned, blocked answer)", () => rig(async ({ mk, addWorker, allowance, spawn }) => {
  const dir = path.join(stateDir(), "codex-attempts.jsonl");
  const ad = mk({ deps: { git: (args, o) => {
    const r = realGit(args, o);
    if (args[0] === "rev-parse") fs.mkdirSync(dir, { recursive: true }); // from here the ledger cannot be appended to
    return r;
  } } });
  const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(allowance.active(), 0, "the reservation is released");
  assert.equal(out.blocked, "failed", JSON.stringify(out));
  assert.equal(spawn.calls.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  // with one allowed job the next request is not stuck behind a leaked reservation
  const again = await mk({ deps: {} }).start(addWorker("docs-01"), "x", { requestId: "r2" });
  assert.equal(again.started, "docs-01.1", JSON.stringify(again));
}, { codex: { max_parallel_jobs: 1 } }));

test("F5 a head lookup that throws releases the allowance too", () => rig(async ({ mk, addWorker, allowance, spawn }) => {
  const ad = mk({ deps: { git: (args, o) => { if (args[0] === "rev-parse") throw new Error("git gone"); return realGit(args, o); } } });
  const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.blocked, "failed", JSON.stringify(out));
  assert.match(out.reason, /git gone/);
  assert.equal(allowance.active(), 0);
  assert.equal(spawn.calls.length, 0);
}, { codex: { max_parallel_jobs: 1 } }));

const fdOpen = (fd) => { try { fs.fstatSync(fd); return true; } catch (e) { if (e.code === "EBADF") return false; throw e; } };

test("F6 the stdio fds are closed after a successful spawn", () => rig(async ({ ad, addWorker, spawn, pollUntil }) => {
  await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  const fds = spawn.calls[0].opts.stdio.filter((x) => typeof x === "number");
  assert.equal(fds.length, 2);
  for (const fd of fds) assert.equal(fdOpen(fd), false, `fd ${fd} still open`);
  await pollUntil((e) => e.some((x) => x.type === "finished"));
}));

test("F6 the stdio fds are closed when spawn throws", () => rig(async ({ ad, addWorker, spawn }) => {
  const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.blocked, "failed");
  const fds = spawn.calls[0].opts.stdio.filter((x) => typeof x === "number");
  assert.equal(fds.length, 2);
  for (const fd of fds) assert.equal(fdOpen(fd), false, `fd ${fd} still open`);
}, { spawn: recordingSpawn({ fail: "boom" }) }));

test("F6 the first fd is closed when the second open fails", () => rig(async ({ ad, addWorker, spawn, env }) => {
  const probe = path.join(env.root, "probe.txt");
  fs.writeFileSync(probe, "x");
  const lowest = () => { const fd = fs.openSync(probe, "r"); fs.closeSync(fd); return fd; };
  const before = lowest();
  fs.mkdirSync(path.join(stateDir(), "codex-out", "auth-01.1.err"), { recursive: true }); // the second openOut cannot open a folder
  const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.blocked, "failed", JSON.stringify(out));
  assert.equal(spawn.calls.length, 0);
  assert.equal(lowest(), before, "no fd leaked by the failed second open");
}));

test("F6 store.closeOut closes an fd opened by openOut", () => rig(async () => {
  const fd = store.openOut("codex-out/x-1.out");
  assert.equal(fdOpen(fd), true);
  store.closeOut(fd);
  assert.equal(fdOpen(fd), false);
  assert.doesNotThrow(() => store.closeOut(fd), "a second close is harmless");
}));

test("F8 the drain keeps FIFO order: a busy head blocks the ones behind it", () => rig(async ({ ad, addWorker, spawn, libState, attempts, workers }) => {
  libState.busy = 3; // both requests queue
  const o1 = await ad.start(addWorker("a-01"), "first", { requestId: "r1" });
  const o2 = await ad.start(addWorker("b-01"), "second", { requestId: "r2" });
  assert.ok(o1.queued && o2.queued);
  // the next gate probe (the head's) says busy, every later one says free: a drain that skipped the head would start b-01
  let n = 0;
  Object.defineProperty(libState, "busy", { get: () => (++n === 1 ? 3 : 0), configurable: true });
  const ev = await ad.poll();
  assert.equal(spawn.calls.length, 0, "the second job did not jump the queue");
  assert.ok(!ev.some((x) => x.type === "started"));
  assert.deepEqual(attempts().filter((l) => l.state === "queued").map((l) => l.attempt_id), ["a-01.1", "b-01.1"]);
  await ad.poll();
  const tasks = spawn.calls.map((c) => c.args[c.args.indexOf("--task") + 1]);
  assert.deepEqual(tasks, ["a-01.1", "b-01.1"], "started in order");
  assert.equal(workers().get("a-01").status, "running");
}));

test("F9 an unknown refusal (quota read failed) keeps a queued job queued; it starts once the read works", () => rig(async ({ ad, addWorker, spawn, libState, attempts, workers }) => {
  libState.busy = 3;
  const o = await ad.start(addWorker("a-01"), "x", { requestId: "r1" });
  assert.ok(o.queued);
  libState.busy = 0;
  libState.readingThrows = true;
  const ev = await ad.poll();
  assert.ok(!ev.some((x) => x.type === "blocked"), JSON.stringify(ev));
  assert.equal(attempts().at(-1).state, "queued");
  assert.equal(workers().get("a-01").status, "queued");
  assert.equal(spawn.calls.length, 0);
  libState.readingThrows = false;
  const ev2 = await ad.poll();
  assert.ok(ev2.some((x) => x.type === "started"));
  assert.equal(spawn.calls.length, 1);
}));

test("F9 a definitive refusal (a conflicting worktree) still blocks the queued job for good", () => rig(async ({ ad, addWorker, spawn, libState, attempts, repo }) => {
  libState.busy = 3;
  const o = await ad.start(addWorker("a-01"), "x", { requestId: "r1" });
  assert.ok(o.queued);
  libState.busy = 0;
  fs.mkdirSync(path.join(repo, ".claude", "worktrees", "codex-a-01"), { recursive: true });
  const ev = await ad.poll();
  assert.ok(ev.some((x) => x.type === "blocked" && x.kind === "conflict"), JSON.stringify(ev));
  assert.equal(attempts().at(-1).state, "blocked");
  assert.equal(spawn.calls.length, 0);
}));

test("F10 a brief left by a crash before the attempt line is replaced on a first spawn", () => rig(async ({ ad, addWorker }) => {
  store.writeNew("briefs/auth-01.1.md", "STALE BRIEF from a crashed run\n");
  const out = await ad.start(addWorker("auth-01"), "the real instruction", { requestId: "r1" });
  assert.equal(out.started, "auth-01.1");
  const brief = fs.readFileSync(path.join(stateDir(), "briefs", "auth-01.1.md"), "utf8");
  assert.ok(!/STALE/.test(brief), brief);
  assert.match(brief, /^New instruction: the real instruction$/m);
}));

// ---- Task 10b: carried fixes from the 10a reviews ---------------------------------------------------------------------------
const finished = (e) => e.some((x) => x.type === "finished");

test("C1 a child whose unref() throws keeps its reservation: the attempt reaches spawned and finishes", async () => {
  const base = recordingSpawn();
  const spawn = (c, a, o) => { const ch = base(c, a, o); ch.unref = () => { throw new Error("unref boom"); }; return ch; };
  spawn.calls = base.calls; spawn.children = base.children;
  await rig(async ({ ad, addWorker, allowance, attempts, pollUntil }) => {
    const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
    assert.equal(out.started, "auth-01.1", JSON.stringify(out));
    assert.equal(allowance.active(), 1, "the child runs: its reservation stays held");
    assert.deepEqual(attempts().map((l) => l.state), ["reserved", "spawned"]);
    await pollUntil(finished);
    assert.equal(allowance.active(), 0);
    assert.equal(attempts().at(-1).state, "done");
  }, { spawn, scenario: { delay_ms: 300 } });
});

test("C1 a child whose on() throws is treated the same way", async () => {
  const base = recordingSpawn();
  const spawn = (c, a, o) => { const ch = base(c, a, o); ch.on = () => { throw new Error("on boom"); }; return ch; };
  spawn.calls = base.calls; spawn.children = base.children;
  await rig(async ({ ad, addWorker, allowance, attempts, pollUntil }) => {
    const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
    assert.equal(out.started, "auth-01.1", JSON.stringify(out));
    assert.equal(allowance.active(), 1);
    await pollUntil(finished);
    assert.equal(attempts().at(-1).state, "done");
  }, { spawn, scenario: { delay_ms: 300 } });
});

test("C2 a transient spawned-append failure keeps the slot until the child's result line, then releases once", async () => {
  const base = recordingSpawn();
  let file = null;
  const spawn = (c, a, o) => { const ch = base(c, a, o); fs.chmodSync(file, 0o444); return ch; }; // the next ledger append fails (read-only)
  spawn.calls = base.calls; spawn.children = base.children;
  await rig(async ({ ad, addWorker, allowance, attempts, pollUntil, workers }) => {
    file = path.join(stateDir(), "codex-attempts.jsonl");
    try { await assert.rejects(ad.start(addWorker("auth-01"), "x", { requestId: "r1" })); } finally { fs.chmodSync(file, 0o666); }
    assert.equal(allowance.active(), 1, "the child is live: the slot stays held");
    assert.equal(attempts().at(-1).state, "reserved");
    const events = await pollUntil(finished);
    assert.equal(events.filter((x) => x.type === "finished").length, 1);
    assert.equal(allowance.active(), 0, "released by the result line");
    assert.equal(attempts().at(-1).state, "done");
    assert.equal(workers().get("auth-01").status, "waiting_for_user");
    assert.deepEqual(await ad.poll(), [], "nothing is finished or released a second time");
    assert.equal(allowance.active(), 0);
  }, { spawn, scenario: { delay_ms: 600 } });
});

const fdRecorder = () => {
  const opened = [], closed = [];
  return { opened, closed,
    openOut: (rel) => { const fd = store.openOut(rel); opened.push(fd); return fd; },
    closeOut: (fd) => { closed.push(fd); store.closeOut(fd); } };
};
const closedOnce = (r, n) => {
  assert.equal(r.opened.length, n, `opened ${JSON.stringify(r.opened)}`);
  assert.deepEqual([...r.closed].sort(), [...r.opened].sort(), "exactly one close per opened fd");
};

test("C4 exactly one close per opened fd: success", () => rig(async ({ mk, addWorker, pollUntil }) => {
  const r = fdRecorder();
  const ad = mk({ deps: { openOut: r.openOut, closeOut: r.closeOut } });
  const out = await ad.start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.started, "auth-01.1");
  closedOnce(r, 2);
  await pollUntil(finished, { adapter: ad });
}));

test("C4 exactly one close per opened fd: spawn throws", () => rig(async ({ mk, addWorker }) => {
  const r = fdRecorder();
  const out = await mk({ deps: { openOut: r.openOut, closeOut: r.closeOut } }).start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.blocked, "failed");
  closedOnce(r, 2);
}, { spawn: recordingSpawn({ fail: "boom" }) }));

test("C4 exactly one close per opened fd: the second open fails", () => rig(async ({ mk, addWorker, spawn }) => {
  const r = fdRecorder();
  fs.mkdirSync(path.join(stateDir(), "codex-out", "auth-01.1.err"), { recursive: true });
  const out = await mk({ deps: { openOut: r.openOut, closeOut: r.closeOut } }).start(addWorker("auth-01"), "x", { requestId: "r1" });
  assert.equal(out.blocked, "failed");
  assert.equal(spawn.calls.length, 0);
  closedOnce(r, 1);
}));

test("m1 assertLibHref accepts only the three lib modules as file URLs", () => {
  for (const n of ["binary", "locks", "usage"]) assert.doesNotThrow(() => assertLibHref(`file:///x/skill/lib/${n}.mjs`), n);
  for (const bad of ["node:fs", "file:///etc/passwd", "file:///x/skill/lib/other.mjs", "file:///x/skill/lib/binary.mjs/../../evil.mjs",
    "file:///x/skill/binary.mjs", "https://example.com/lib/binary.mjs", "", 42, null]) {
    assert.throws(() => assertLibHref(bad), /lib/, String(bad));
  }
});

test("m2 a login probe that says unknown at the gate keeps a queued job queued", () => {
  let who = "chatgpt";
  return rig(async ({ ad, addWorker, spawn, libState, attempts, workers }) => {
    libState.busy = 3;
    assert.ok((await ad.start(addWorker("a-01"), "x", { requestId: "r1" })).queued);
    libState.busy = 0;
    who = "unknown";
    const ev = await ad.poll();
    assert.ok(!ev.some((x) => x.type === "blocked"), JSON.stringify(ev));
    assert.equal(attempts().at(-1).state, "queued");
    assert.equal(workers().get("a-01").status, "queued");
    assert.equal(spawn.calls.length, 0);
    who = "chatgpt";
    assert.ok((await ad.poll()).some((x) => x.type === "started"));
  }, { login: async () => who });
});

test("m2 a fresh login probe that says unknown right before the spawn keeps a queued job queued", () => {
  const answers = ["chatgpt", "chatgpt", "unknown"]; // start's gate, the drain's gate, the drain's fresh probe; then chatgpt
  return rig(async ({ ad, addWorker, spawn, libState, attempts, allowance }) => {
    libState.busy = 3;
    assert.ok((await ad.start(addWorker("a-01"), "x", { requestId: "r1" })).queued);
    libState.busy = 0;
    const ev = await ad.poll();
    assert.ok(!ev.some((x) => x.type === "blocked"), JSON.stringify(ev));
    assert.equal(attempts().at(-1).state, "queued");
    assert.equal(spawn.calls.length, 0);
    assert.equal(allowance.active(), 0);
    assert.ok((await ad.poll()).some((x) => x.type === "started"));
  }, { login: async () => answers.shift() ?? "chatgpt" });
});

// ---- Task 11 fix round, P1: a worker made with --in <finished worker> runs in that worker's worktree ----------------------------
const norm = (p) => path.resolve(p).split(path.sep).join("/").toLowerCase();

test("P1 a worker with in_worktree_of runs in the ref's worktree: ensureWorktree verifies it (creates no codex-<id>), --cwd, head_before and the attempt use it", () => rig(async ({ ad, repo, addWorker, spawn, attempts, pollUntil }) => {
  const ref = addWorker("ref-01");
  const wt = ad.ensureWorktree(ref);
  assert.equal(wt.ok, true);
  fs.writeFileSync(path.join(wt.worktree, "ref.txt"), "ref work\n");
  git(wt.worktree, "add", "ref.txt");
  git(wt.worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "ref work");
  const refHead = git(wt.worktree, "rev-parse", "HEAD");
  assert.notEqual(refHead, git(repo, "rev-parse", "HEAD"));
  const w = addWorker("fix-01", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: wt.branch });
  const r = ad.ensureWorktree(w);
  assert.deepEqual(r, { ok: true, worktree: wt.worktree, branch: "codex-ref-01" });
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", "codex-fix-01")), "no worktree of its own");
  assert.equal(git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 2);
  const out = await ad.start(w, "Continue in the same tree", { requestId: "r1" });
  assert.equal(out.started, "fix-01.1");
  const argv = spawn.calls.at(-1).args;
  assert.equal(norm(argv[argv.indexOf("--cwd") + 1]), norm(wt.worktree), "codex-run --cwd is the ref's worktree");
  const a = attempts().filter((x) => x.attempt_id === "fix-01.1").at(-1);
  assert.equal(norm(a.worktree), norm(wt.worktree));
  assert.equal(a.head_before, refHead, "the head lookup reads the ref's worktree");
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", "codex-fix-01")));
  await pollUntil((ev) => ev.some((e) => e.type === "finished"));
}));

test("P1 a recorded worktree on another branch, one git does not list, or a missing one is refused, and codex-<id> is never created", () => rig(async ({ ad, repo, addWorker, start }) => {
  const ref = addWorker("ref-01");
  const wt = ad.ensureWorktree(ref);
  const other = path.join(repo, ".claude", "worktrees", "elsewhere");
  git(repo, "worktree", "add", "-b", "other-branch", other, "HEAD");
  const wrongBranch = ad.ensureWorktree(addWorker("a-01", { in_worktree_of: "ref-01", worktree: other, branch: "codex-ref-01" }));
  assert.equal(wrongBranch.ok, false);
  assert.match(wrongBranch.reason, /other-branch/);
  const notListed = path.join(repo, ".claude", "worktrees", "plain-folder");
  fs.mkdirSync(notListed, { recursive: true });
  const unlisted = ad.ensureWorktree(addWorker("b-01", { in_worktree_of: "ref-01", worktree: notListed, branch: "codex-ref-01" }));
  assert.equal(unlisted.ok, false);
  assert.match(unlisted.reason, /not a worktree of this repository/);
  const gone = ad.ensureWorktree(addWorker("c-01", { in_worktree_of: "ref-01", worktree: path.join(repo, "nowhere"), branch: "codex-ref-01" }));
  assert.equal(gone.ok, false);
  for (const id of ["a-01", "b-01", "c-01"]) assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", `codex-${id}`)), id);
  assert.equal(ad.ensureWorktree(addWorker("d-01", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: "refs/heads/codex-ref-01" })).ok, true, "a full ref name for the branch is accepted");
}));

test("P1 the continuation rules read the shared worktree: a dirty shared tree after a done run is continued, not read from codex-<id>", () => rig(async ({ ad, repo, addWorker, pollUntil, spawn }) => {
  const ref = addWorker("ref-01");
  const wt = ad.ensureWorktree(ref);
  const w = addWorker("fix-01", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: wt.branch });
  await ad.start(w, "first", { requestId: "r1" });
  await pollUntil((ev) => ev.some((e) => e.type === "finished"));
  fs.writeFileSync(path.join(wt.worktree, "left-over.txt"), "uncommitted\n");
  assert.equal(ad.planRun(w, [{ attempt_id: "fix-01.1", seq: 1, state: "done", head_before: git(wt.worktree, "rev-parse", "HEAD"), run_id: "run-1", worktree: wt.worktree }]), "continue");
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", "codex-fix-01")));
}));

// ---- Task 11 re-review fixes: the shared checkout is verified by git inside it ----------------------------------------------------
const noDir = (repo, id) => assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", `codex-${id}`)), `codex-${id} must not be created`);

test("Q1 a listed worktree path now holding another repository's checkout is refused", () => rig(async ({ ad, repo, env, addWorker }) => {
  const ref = addWorker("ref-01");
  const wt = ad.ensureWorktree(ref);
  assert.equal(wt.ok, true);
  fs.rmSync(wt.worktree, { recursive: true, force: true });
  const other = makeRepo(env.root, "other");
  git(other, "worktree", "add", "-b", "codex-ref-01", wt.worktree, "HEAD");
  assert.ok(git(repo, "worktree", "list", "--porcelain").includes("codex-ref-01"), "the first repository still lists the path");
  const r = ad.ensureWorktree(addWorker("fix-01", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: "codex-ref-01" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /another repository/);
  noDir(repo, "fix-01");
}));

test("Q1 the main checkout is refused even when it is listed and on the recorded branch", () => rig(async ({ ad, repo, addWorker }) => {
  const r = ad.ensureWorktree(addWorker("fix-01", { in_worktree_of: "ref-01", worktree: repo, branch: git(repo, "rev-parse", "--abbrev-ref", "HEAD") }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /main checkout/);
  noDir(repo, "fix-01");
}));

test("Q1 a listed worktree whose folder was deleted (stale registration) is refused", () => rig(async ({ ad, repo, addWorker }) => {
  const wt = ad.ensureWorktree(addWorker("ref-01"));
  fs.rmSync(wt.worktree, { recursive: true, force: true });
  assert.ok(git(repo, "worktree", "list", "--porcelain").includes(path.basename(wt.worktree)), "git still lists it");
  const r = ad.ensureWorktree(addWorker("fix-01", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: "codex-ref-01" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /stale|does not exist/);
  noDir(repo, "fix-01");
}));

test("Q1 a path spelled with a literal trailing dot segment (and, on Windows, in another case) still verifies against the real checkout", () => rig(async ({ ad, addWorker }) => {
  const wt = ad.ensureWorktree(addWorker("ref-01"));
  const spellings = [`${wt.worktree}/.`, `${wt.worktree}${path.sep}.${path.sep}`, `${wt.worktree}/../${path.basename(wt.worktree)}`];
  if (process.platform === "win32") spellings.push(wt.worktree.toUpperCase(), wt.worktree.toLowerCase().replace(/\\/g, "/"));
  for (const [i, spelled] of spellings.entries()) {
    const ok = ad.ensureWorktree(addWorker(`fix-0${i + 1}`, { in_worktree_of: "ref-01", worktree: spelled, branch: "codex-ref-01" }));
    assert.equal(ok.ok, true, `${spelled}: ${JSON.stringify(ok)}`);
  }
}));

test("Q1 a detached HEAD in the shared worktree is refused", () => rig(async ({ ad, repo, addWorker }) => {
  const wt = ad.ensureWorktree(addWorker("ref-01"));
  git(wt.worktree, "checkout", "-q", "--detach");
  const bad = ad.ensureWorktree(addWorker("fix-02", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: "codex-ref-01" }));
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /detached/);
  noDir(repo, "fix-02");
}));

// R2: git's common dir is compared case-sensitively off Windows. The repositories are faked through the injected git (two real repos
// that differ only in case cannot exist on a case-insensitive disk), and the platform is injected.
test("R2 the common git dir is compared with case folded only on win32: /repos/Main/.git and /repos/main/.git are different repositories on POSIX", () => rig(async ({ mk, repo, addWorker, ad }) => {
  const wt = ad.ensureWorktree(addWorker("ref-01"));
  const fakeCommon = (common) => (args, o) => {
    const r = realGit(args, o);
    const inRepo = path.resolve(o.cwd) === path.resolve(repo);
    if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { ...r, stdout: inRepo ? "/repos/main/.git\n" : `${common}\n` };
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && !inRepo) return { ...r, stdout: `${wt.worktree}\n` };
    return r;
  };
  const w = (id) => addWorker(id, { in_worktree_of: "ref-01", worktree: wt.worktree, branch: "codex-ref-01" });
  const posixCase = mk({ deps: { platform: "linux", git: fakeCommon("/repos/Main/.git") } }).ensureWorktree(w("fix-01"));
  assert.equal(posixCase.ok, false, "case-distinct common dirs on POSIX are two repositories");
  assert.match(posixCase.reason, /another repository/);
  const posixSame = mk({ deps: { platform: "linux", git: fakeCommon("/repos/main/.git") } }).ensureWorktree(w("fix-02"));
  assert.equal(posixSame.ok, true, JSON.stringify(posixSame));
  const win = mk({ deps: { platform: "win32", git: fakeCommon("/repos/Main/.git") } }).ensureWorktree(w("fix-03"));
  assert.equal(win.ok, true, "on Windows the same two spellings are one repository: " + JSON.stringify(win));
}));

test("Q3 in_worktree_of with a missing or empty worktree or branch is refused and never reaches git worktree add", () => rig(async ({ mk, repo, addWorker }) => {
  const gitCalls = [];
  const ad = mk({ deps: { git: (args, o) => { gitCalls.push(args.join(" ")); return realGit(args, o); } } });
  const cases = [{ branch: null }, { branch: "" }, { branch: "   " }, { worktree: null }, { worktree: "" }];
  for (const [i, c] of cases.entries()) {
    const w = addWorker(`inc-0${i + 1}`, { in_worktree_of: "ref-01", worktree: path.join(repo, "x"), branch: "b", ...c });
    const r = ad.ensureWorktree(w);
    assert.equal(r.ok, false, JSON.stringify(c));
    assert.match(r.reason, /in_worktree_of but no recorded/);
    noDir(repo, w.id);
  }
  assert.ok(!gitCalls.some((c) => c.startsWith("worktree add")), gitCalls.join(" | "));
  // start() reaches the same refusal through the gate and never spawns
  const w = addWorker("inc-09", { in_worktree_of: "ref-01", branch: null });
  const out = await ad.start(w, "go", { requestId: "q3" });
  assert.ok(out.clarify || out.blocked, JSON.stringify(out));
  noDir(repo, "inc-09");
  assert.ok(!gitCalls.some((c) => c.startsWith("worktree add")));
}));

test("Q5 a new --in worker's first run on a tree the ref left dirty is fresh (no --continue); a codex-run `dirty: ...` refusal propagates to the worker as blocked", () => rig(async ({ ad, addWorker, spawn, pollUntil, workers, repo }) => {
  const wt = ad.ensureWorktree(addWorker("ref-01"));
  fs.writeFileSync(path.join(wt.worktree, "left-over.txt"), "uncommitted\n");
  const w = addWorker("fix-01", { in_worktree_of: "ref-01", worktree: wt.worktree, branch: wt.branch });
  assert.equal(ad.planRun(w, []), "fresh");
  const out = await ad.start(w, "go on", { requestId: "q5" });
  assert.equal(out.started, "fix-01.1");
  assert.ok(!spawn.calls.at(-1).args.includes("--continue"));
  // Propagation test only: the dirty-tree refusal below is injected through the fake codex-run scenario. The real guard (codex-run
  // refusing a write run on a dirty tree that is not a --continue) belongs to codex-run's own suite, not to this adapter.
  await pollUntil((ev) => ev.some((e) => e.type === "finished"));
  const worker = workers().get("fix-01");
  assert.equal(worker.status, "blocked");
  assert.match(worker.blockers[0], /^dirty: left-over\.txt/);
  noDir(repo, "fix-01");
}, { scenario: { status: "blocked", reason: "dirty: left-over.txt" } }));

// ---- Task 13 fix round, M1: the worker's own repo decides where its worktree lives -------------------------------------------
test("T13 M1 no repo anywhere: ensureWorktree and start answer a clear 'no repo' instead of throwing", () => rig(async ({ mk, addWorker }) => {
  const noRepo = mk({ repo: null });
  const w = addWorker("n-01", { repo: null });
  assert.deepEqual(noRepo.ensureWorktree(w), { ok: false, reason: "no repo" });
  const out = await noRepo.start(w, "do it", { requestId: "r1" });
  assert.match(String(out.clarify), /no repo/);
  assert.equal(noRepo.planRun(w, [{ attempt_id: "n-01.1", seq: 1, state: "done", head_before: "x" }]), "clarify", "continuation rules do not throw either");
}));

test("T13 M1 the worker's stored repo wins over the coordinator's start repo; a worker with no repo falls back to the start repo", () => rig(async ({ env, ad, repo, addWorker, spawn }) => {
  const repoB = makeRepo(env.root, "repoB");
  const w = addWorker("b-01", { repo: repoB });
  const r = ad.ensureWorktree(w);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(norm(r.worktree), norm(path.join(repoB, ".claude", "worktrees", "codex-b-01")));
  assert.ok(!fs.existsSync(path.join(repo, ".claude", "worktrees", "codex-b-01")), "nothing is created in the start repo");
  assert.equal(git(repoB, "worktree", "list", "--porcelain").split(""+String.fromCharCode(10)).filter((l) => l.startsWith("worktree ")).length, 2);
  const out = await ad.start(w, "go", { requestId: "r1" });
  assert.equal(out.started, "b-01.1");
  const argv = spawn.calls.at(-1).args;
  assert.equal(norm(argv[argv.indexOf("--cwd") + 1]), norm(r.worktree));
  const legacy = addWorker("l-01", { repo: undefined });
  assert.equal(legacy.repo ?? null, null);
  assert.equal(norm(ad.ensureWorktree(legacy).worktree), norm(path.join(repo, ".claude", "worktrees", "codex-l-01")));
}));
