// Task 10b: continuation rules (planRun), the --continue wiring, restart reconcile, and the poll-time dead-run handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { mcEnv, withEnv, makeRepo, fakeCodexLib, recordingSpawn, sleep, FAKE_CODEX_RUN } from "./mc-helpers.mjs";
import { DEFAULTS } from "../config.mjs";
import { stateDir } from "../paths.mjs";
import * as store from "../store.mjs";
import { foldWorkers } from "../workers.mjs";
import { createAllowance } from "../codex-resources.mjs";
import { createCodexAdapter } from "../codex-adapter.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...a], { cwd, encoding: "utf8", windowsHide: true }).trim();
const finished = (e) => e.some((x) => x.type === "finished");
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

async function rig(body, { codex = {}, scenario = {}, spawn = recordingSpawn(), deps = {}, login = async () => "chatgpt" } = {}) {
  const env = mcEnv({ FAKE_LOGIN: "chatgpt" });
  const extra = [];
  try {
    const repo = makeRepo(env.root);
    const scenarioFile = path.join(env.root, "scenario.json");
    const setScenario = (s) => fs.writeFileSync(scenarioFile, JSON.stringify(s));
    setScenario(scenario);
    env.FAKE_RUN_SCENARIO = scenarioFile;
    return await withEnv(env, async () => {
      const cfg = { ...structuredClone(DEFAULTS), codex: { ...DEFAULTS.codex, ...codex } };
      const libState = {}, lib = fakeCodexLib(libState);
      const allowance = createAllowance(cfg.codex.max_parallel_jobs);
      const mk = (o = {}) => createCodexAdapter({
        cfg, repo, lib, allowance: o.allowance ?? allowance, login,
        deps: { spawn, codexRunPath: FAKE_CODEX_RUN, requeueDelayMs: 0, ...deps, ...(o.deps ?? {}) },
      });
      const ad = mk();
      const workers = () => foldWorkers(store.readJsonl("workers"));
      const addWorker = (id, more = {}) => {
        store.appendJsonl("workers", { ev: "created", id, provider: "codex", label: id.replace(/-\d+$/, ""), objective: `Objective of ${id}`, repo, created_at: new Date().toISOString(), ...more });
        return workers().get(id);
      };
      const attempts = () => {
        const m = new Map();
        for (const l of store.readJsonl("codex-attempts")) m.set(l.attempt_id, l);
        return [...m.values()];
      };
      const pollUntil = async (cond, { ms = 30000, adapter = ad } = {}) => {
        const t0 = Date.now(), events = [];
        for (;;) {
          events.push(...await adapter.poll());
          if (cond(events)) return events;
          if (Date.now() - t0 > ms) throw new Error(`pollUntil timed out; attempts: ${JSON.stringify(attempts().map((a) => [a.attempt_id, a.state]))}`);
          await sleep(100);
        }
      };
      /** Writes an attempt line (and its out file) as an earlier coordinator process would have left them. */
      const craft = (a, { out = null, err = null } = {}) => {
        const full = { attempt_id: `${a.worker_id}.${a.seq ?? 1}`, request_id: `req-${a.worker_id}-${a.seq ?? 1}`, seq: 1, requeues: 0,
          at: new Date().toISOString(), ...a };
        full.out ??= `codex-out/${full.attempt_id}.out`;
        full.brief ??= `briefs/${full.attempt_id}.md`;
        store.appendJsonl("codex-attempts", full);
        fs.mkdirSync(path.join(stateDir(), "codex-out"), { recursive: true });
        if (out !== null) fs.writeFileSync(path.join(stateDir(), full.out), out);
        if (err !== null) fs.writeFileSync(path.join(stateDir(), full.out.replace(/\.out$/, ".err")), err);
        return full;
      };
      const ledgerLine = (l) => {
        const f = path.join(env.dirs.cfg, "state", "codex", "runs.jsonl");
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.appendFileSync(f, JSON.stringify({ ts: Date.now(), ...l }) + "\n");
      };
      const liveChild = (ms = 4000) => {
        const c = nodeSpawn(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], { stdio: "ignore", windowsHide: true });
        extra.push(c);
        return c;
      };
      const deadPid = () => spawnSync(process.execPath, ["-e", ""], { windowsHide: true }).pid;
      return await body({ env, repo, mk, ad, spawn, allowance, workers, addWorker, setScenario, pollUntil, attempts, cfg, craft, ledgerLine, liveChild, deadPid, libState });
    });
  } finally {
    for (const c of [...(spawn.children ?? []), ...extra]) { try { c.kill(); } catch { /* already gone */ } }
    await sleep(200);
    env.cleanup();
  }
}

const wtOf = (ad, w) => { const r = ad.ensureWorktree(w); assert.equal(r.ok, true, JSON.stringify(r)); return r.worktree; };
const headOf = (wt) => git(wt, "rev-parse", "HEAD");
const dirty = (wt, name = "src/residue.js") => { fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true }); fs.writeFileSync(path.join(wt, name), "x\n"); };
const commitAll = (wt, msg = "user commit") => { git(wt, "add", "-A", "--", ".", ":!.codex-tmp"); git(wt, "commit", "-q", "-m", msg); };
const att = (more) => ({ attempt_id: "auth-01.1", worker_id: "auth-01", seq: 1, state: "done", run_id: "run-1", ...more });

// ---- M1: planRun, one test per rule --------------------------------------------------------------------------------------------
test("M1 rule 1: a last attempt that is queued, reserved or spawned gives queue", () => rig(async ({ ad, addWorker }) => {
  const w = addWorker("auth-01");
  wtOf(ad, w);
  for (const state of ["queued", "reserved", "spawned"]) assert.equal(ad.planRun(w, [att({ state })]), "queue", state);
  // the newest attempt counts, not an older one
  assert.equal(ad.planRun(w, [att({ state: "spawned" }), att({ attempt_id: "auth-01.2", seq: 2, state: "done" })]), "fresh");
  assert.equal(ad.planRun(w, [att({ state: "done" }), att({ attempt_id: "auth-01.2", seq: 2, state: "queued" })]), "queue");
}));

test("M1 rule 2: no attempt, or a clean tree with HEAD at head_before, gives fresh", () => rig(async ({ ad, addWorker }) => {
  const w = addWorker("auth-01");
  assert.equal(ad.planRun(w, []), "fresh", "no attempt, no worktree yet");
  const wt = wtOf(ad, w);
  assert.equal(ad.planRun(w, []), "fresh");
  assert.equal(ad.planRun(w, [att({ head_before: headOf(wt) })]), "fresh");
  // the scratch folder of a codex-run is not residue
  dirty(wt, ".codex-tmp/run/x.txt");
  assert.equal(ad.planRun(w, [att({ head_before: headOf(wt) })]), "fresh");
  // the removed `widen` option is not read
  assert.equal(ad.planRun(w, [], { widen: true }), "fresh");
}));

test("M1 rule 3: a dirty tree, HEAD at head_before and a done last attempt with a run id gives continue", () => rig(async ({ ad, addWorker }) => {
  const w = addWorker("auth-01");
  const wt = wtOf(ad, w);
  const head = headOf(wt);
  dirty(wt);
  assert.equal(ad.planRun(w, [att({ head_before: head })]), "continue");
  // the run id must be one codex-run accepts
  assert.equal(ad.planRun(w, [att({ head_before: head, run_id: undefined })]), "clarify", "done without a run id");
  assert.equal(ad.planRun(w, [att({ head_before: head, run_id: "../x" })]), "clarify", "a run id codex-run would refuse");
  assert.equal(ad.planRun(w, [att({ head_before: head, run_id: "a b" })]), "clarify");
  // another worktree's attempt cannot be continued here
  assert.equal(ad.planRun(w, [att({ head_before: head, worktree: path.join(path.dirname(wt), "elsewhere") })]), "clarify");
}));

test("M1 rule 4: a clean tree with HEAD moved (the user committed) gives fresh", () => rig(async ({ ad, addWorker }) => {
  const w = addWorker("auth-01");
  const wt = wtOf(ad, w);
  const before = headOf(wt);
  dirty(wt);
  commitAll(wt);
  assert.notEqual(headOf(wt), before);
  assert.equal(ad.planRun(w, [att({ head_before: before })]), "fresh");
  assert.equal(ad.planRun(w, [att({ head_before: before, state: "failed", run_id: undefined })]), "fresh");
}));

test("M1 rule 5: anything else gives clarify (dirty with HEAD moved; dirty after a failed, blocked or unknown run; git failing)", () => rig(async ({ ad, addWorker, mk }) => {
  const w = addWorker("auth-01");
  const wt = wtOf(ad, w);
  const before = headOf(wt);
  dirty(wt);
  for (const state of ["failed", "blocked", "unknown"]) assert.equal(ad.planRun(w, [att({ head_before: before, state })]), "clarify", state);
  commitAll(wt);
  dirty(wt, "src/more.js");
  assert.equal(ad.planRun(w, [att({ head_before: before })]), "clarify", "dirty with HEAD moved");
  const broken = mk({ deps: { git: () => ({ code: 128, stdout: "", stderr: "fatal" }) } });
  assert.equal(broken.planRun(w, [att({ head_before: before })]), "clarify", "git failing");
}));

test("R5 planRun reads the tree only through the injected git runner", () => rig(async ({ mk, addWorker, ad }) => {
  const w = addWorker("auth-01");
  const wt = wtOf(ad, w);
  const calls = [];
  const fake = mk({ deps: { git: (args, o) => {
    calls.push([args, o?.cwd]);
    if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
    return { code: 0, stdout: "?? src/x.js\n", stderr: "" };
  } } });
  assert.equal(fake.planRun(w, [att({ head_before: "abc123" })]), "continue");
  assert.ok(calls.some(([a]) => a[0] === "rev-parse" && a.includes("HEAD")));
  assert.ok(calls.some(([a]) => a.includes("status") && a.includes("--porcelain")));
  for (const [, cwd] of calls) assert.equal(path.resolve(cwd), path.resolve(wt));
}));

// ---- M2: the continuation through start -------------------------------------------------------------------------------------------
const RESIDUE = { files: { "src/login.js": "export const ok = 1;\n" }, codex_note: "residue" };

test("M2 after a done run that left residue with HEAD unchanged, the next start passes --continue <run_id>", () => rig(async ({ ad, spawn, addWorker, attempts, pollUntil }) => {
  const w = addWorker("auth-01");
  assert.equal((await ad.start(w, "first", { requestId: "r1" })).started, "auth-01.1");
  await pollUntil(finished);
  assert.ok(!spawn.calls[0].args.includes("--continue"), "the first run is fresh");
  const runId = attempts()[0].run_id;
  assert.ok(runId);
  const out = await ad.start(w, "second", { requestId: "r2" });
  assert.equal(out.started, "auth-01.2", JSON.stringify(out));
  const args = spawn.calls[1].args;
  assert.equal(args[args.indexOf("--continue") + 1], runId);
  assert.equal(attempts()[1].mode, "continue");
  assert.equal(attempts()[1].continue_from, runId);
  await pollUntil(finished);
  assert.equal(attempts()[1].state, "done");
  assert.equal(attempts()[1].result.mode, "write");
}, { scenario: RESIDUE }));

test("M2 after a commit in the worktree (clean, HEAD moved) the next start is fresh, without --continue", () => rig(async ({ ad, spawn, addWorker, attempts, pollUntil }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "first", { requestId: "r1" });
  await pollUntil(finished);
  commitAll(path.resolve(attempts()[0].worktree));
  const out = await ad.start(w, "second", { requestId: "r2" });
  assert.equal(out.started, "auth-01.2", JSON.stringify(out));
  assert.ok(!spawn.calls[1].args.includes("--continue"));
  assert.equal(attempts()[1].mode, "fresh");
}, { scenario: RESIDUE }));

test("M2 a dirty tree with HEAD moved gives {clarify} and no spawn, and writes no attempt line", () => rig(async ({ ad, spawn, addWorker, attempts, pollUntil, allowance }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "first", { requestId: "r1" });
  await pollUntil(finished);
  const wt = path.resolve(attempts()[0].worktree);
  commitAll(wt);
  dirty(wt, "src/other.js");
  const lines = store.readJsonl("codex-attempts").length;
  const out = await ad.start(w, "second", { requestId: "r2" });
  assert.deepEqual(Object.keys(out), ["clarify"]);
  assert.match(out.clarify, /\S/);
  assert.equal(spawn.calls.length, 1);
  assert.equal(store.readJsonl("codex-attempts").length, lines);
  assert.equal(allowance.active(), 0);
}, { scenario: RESIDUE }));

// ---- R3: a second request for a busy worker queues -----------------------------------------------------------------------------
test("R3 a second start for a worker whose last attempt is spawned queues (no second spawn), then runs as a continuation", () => rig(async ({ ad, spawn, addWorker, attempts, allowance, workers, pollUntil }) => {
  const w = addWorker("auth-01");
  assert.equal((await ad.start(w, "first", { requestId: "r1" })).started, "auth-01.1");
  const out = await ad.start(w, "second", { requestId: "r2" });
  assert.deepEqual(Object.keys(out), ["queued"]);
  assert.equal(out.queued, "auth-01.2");
  assert.equal(spawn.calls.length, 1, "no second spawn, no worktree-busy requeue");
  assert.equal(allowance.active(), 1);
  assert.equal(workers().get("auth-01").status, "running", "the running attempt still counts");
  assert.equal(ad.status(workers().get("auth-01")).status, "running");
  assert.equal((await ad.start(w, "second", { requestId: "r2" })).existing, true, "a retry of the queued request");
  const events = await pollUntil((e) => e.filter((x) => x.type === "finished").length === 2);
  assert.ok(events.some((x) => x.type === "started" && x.attempt_id === "auth-01.2"));
  assert.equal(spawn.calls.length, 2);
  const second = attempts().find((a) => a.attempt_id === "auth-01.2");
  assert.equal(second.state, "done");
  assert.equal(second.requeues, 0);
  const args = spawn.calls[1].args;
  assert.equal(args[args.indexOf("--continue") + 1], attempts()[0].run_id, "the first run left residue: continue");
  assert.equal(allowance.active(), 0);
}, { scenario: { ...RESIDUE, tasks: { "auth-01.1": { delay_ms: 1200 } } } }));

test("R3 a queued attempt whose worktree became unclear before its turn is blocked, not started", () => rig(async ({ ad, spawn, addWorker, attempts, pollUntil, workers }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "first", { requestId: "r1" });
  assert.ok((await ad.start(w, "second", { requestId: "r2" })).queued);
  const wt = path.resolve(attempts()[0].worktree);
  const out = path.join(stateDir(), attempts()[0].out);
  for (let t0 = Date.now(); !(fs.existsSync(out) && fs.readFileSync(out, "utf8").includes("{")); await sleep(100)) assert.ok(Date.now() - t0 < 30000, "the first run did not end");
  commitAll(wt); // the user commits and edits before the queued job's turn comes
  dirty(wt, "src/other.js");
  const events = await ad.poll();
  assert.ok(events.some((x) => x.type === "finished" && x.attempt_id === "auth-01.1"), JSON.stringify(events));
  assert.ok(events.some((x) => x.type === "blocked" && x.attempt_id === "auth-01.2"), JSON.stringify(events));
  assert.equal(attempts()[1].state, "blocked");
  assert.equal(spawn.calls.length, 1);
  assert.equal(workers().get("auth-01").status, "blocked");
}, { scenario: { ...RESIDUE, tasks: { "auth-01.1": { delay_ms: 600 } } } }));

// ---- R4: codex-run's own continue check is final --------------------------------------------------------------------------------
test("R4 a --continue that codex-run refuses ends the attempt blocked with its reason (no crash, no requeue)", () => rig(async ({ ad, spawn, addWorker, attempts, workers, allowance, pollUntil }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "first", { requestId: "r1" });
  await pollUntil(finished);
  const out = await ad.start(w, "second", { requestId: "r2" });
  assert.equal(out.started, "auth-01.2");
  await pollUntil((e) => e.some((x) => x.type === "finished" && x.attempt_id === "auth-01.2"));
  const a = attempts()[1];
  assert.equal(a.state, "blocked");
  assert.match(a.result.reason, /^continue-mismatch: the worktree differs/);
  assert.equal(a.requeues, 0);
  assert.equal(spawn.calls.length, 2);
  assert.equal(workers().get("auth-01").status, "blocked");
  assert.ok(workers().get("auth-01").blockers.some((b) => /^continue-mismatch/.test(b)));
  assert.equal(allowance.active(), 0);
  // the next request after the block: the tree is still dirty after a blocked run: clarify, never a blind retry
  const again = await ad.start(w, "third", { requestId: "r3" });
  assert.ok(again.clarify, JSON.stringify(again));
}, { scenario: { ...RESIDUE, tasks: { "auth-01.2": { continue_refuse: "continue-mismatch: the worktree differs from that run's final state" } } } }));

// ---- M3: reconcile ---------------------------------------------------------------------------------------------------------------
const RESULT = (run, extra = {}) => JSON.stringify({ run, status: "done", reason: null, mode: "write", model: "sol", secs: 3, files: ["a.js"], checks: [], codex_note: "ok", week_pct: 10, orphans: [], ...extra }) + "\n";

test("M3 a spawned attempt whose out file has the result line is persisted", () => rig(async ({ ad, addWorker, craft, attempts, workers, allowance }) => {
  addWorker("auth-01");
  craft({ worker_id: "auth-01", state: "spawned", pid: 999999 }, { out: RESULT("run-9") });
  const events = await ad.reconcile();
  assert.ok(events.some((x) => x.type === "finished" && x.attempt_id === "auth-01.1"), JSON.stringify(events));
  assert.equal(attempts()[0].state, "done");
  assert.equal(attempts()[0].run_id, "run-9");
  assert.equal(workers().get("auth-01").status, "waiting_for_user");
  assert.equal(allowance.active(), 0);
}));

test("M3 a spawned attempt with a live pid stays reserved and watched: active() is 1", () => rig(async ({ ad, addWorker, craft, attempts, allowance, liveChild, workers }) => {
  addWorker("auth-01");
  const child = liveChild();
  craft({ worker_id: "auth-01", state: "spawned", pid: child.pid }, { out: "" });
  assert.equal(allowance.active(), 0);
  const events = await ad.reconcile();
  assert.deepEqual(events, []);
  assert.equal(allowance.active(), 1, "the allowance is rebuilt from the watched attempt");
  assert.equal(attempts()[0].state, "spawned");
  assert.equal(workers().get("auth-01").status, "starting", "nothing is rewritten for a watched attempt");
  assert.deepEqual(await ad.poll(), [], "poll leaves it alone while the pid lives and no line is there");
  assert.equal(allowance.active(), 1);
}));

test("M3 a spawned attempt with a dead pid and a Codex ledger line is persisted from the ledger", () => rig(async ({ ad, addWorker, craft, attempts, allowance, workers, deadPid, ledgerLine }) => {
  addWorker("auth-01");
  craft({ worker_id: "auth-01", state: "spawned", pid: deadPid() }, { out: "" });
  ledgerLine({ run_id: "run-led", task: "auth-01.1", status: "done", files: ["b.js"] });
  ledgerLine({ run_id: "run-other", task: "auth-02.1", status: "failed" });
  await ad.reconcile();
  const a = attempts()[0];
  assert.equal(a.state, "done");
  assert.equal(a.run_id, "run-led");
  assert.equal(workers().get("auth-01").status, "waiting_for_user");
  assert.deepEqual(workers().get("auth-01").files_changed, ["b.js"]);
  assert.equal(allowance.active(), 0);
}));

test("M3 a ledger line of a failed run gives a failed attempt", () => rig(async ({ ad, addWorker, craft, attempts, workers, deadPid, ledgerLine }) => {
  addWorker("auth-01");
  craft({ worker_id: "auth-01", state: "spawned", pid: deadPid() }, { out: "" });
  ledgerLine({ run_id: "run-f", task: "auth-01.1", status: "failed" });
  await ad.reconcile();
  assert.equal(attempts()[0].state, "failed");
  assert.equal(workers().get("auth-01").status, "failed");
}));

test("M3 a spawned attempt with a dead pid and neither line becomes unknown; the worker keeps its worktree", () => rig(async ({ ad, addWorker, craft, attempts, allowance, workers, deadPid }) => {
  const w = addWorker("auth-01");
  const wt = wtOf(ad, w);
  craft({ worker_id: "auth-01", state: "spawned", pid: deadPid(), worktree: wt }, { out: "" });
  const events = await ad.reconcile();
  assert.ok(events.some((x) => x.type === "unknown" && x.attempt_id === "auth-01.1"), JSON.stringify(events));
  assert.equal(attempts()[0].state, "unknown");
  assert.equal(attempts()[0].worktree, wt);
  assert.equal(workers().get("auth-01").status, "unknown");
  assert.equal(ad.status(workers().get("auth-01")).status, "unknown");
  assert.ok(fs.existsSync(wt), "the worktree is kept");
  assert.equal(allowance.active(), 0);
  for (const e of store.readJsonl("workers").filter((x) => x.ev === "status")) assert.ok(!Number.isNaN(Date.parse(e.at)), "every status event carries at");
}));

test("M3 a reserved-only attempt becomes blocked: not-spawned", () => rig(async ({ ad, addWorker, craft, attempts, workers, allowance }) => {
  addWorker("auth-01");
  craft({ worker_id: "auth-01", state: "reserved" });
  const events = await ad.reconcile();
  assert.ok(events.some((x) => x.type === "blocked" && x.reason === "not-spawned"), JSON.stringify(events));
  assert.equal(attempts()[0].state, "blocked");
  assert.equal(attempts()[0].reason, "not-spawned");
  assert.equal(workers().get("auth-01").status, "blocked");
  assert.deepEqual(workers().get("auth-01").blockers, ["not-spawned"]);
  assert.equal(allowance.active(), 0);
}));

test("M3 a live pid older than 40 minutes is not watched: it takes the unknown path (or the ledger)", () => rig(async ({ ad, addWorker, craft, attempts, allowance, liveChild, ledgerLine, workers }) => {
  addWorker("auth-01"); addWorker("auth-02");
  const c1 = liveChild(), c2 = liveChild();
  craft({ worker_id: "auth-01", state: "spawned", pid: c1.pid, at: minutesAgo(41) }, { out: "" });
  craft({ worker_id: "auth-02", state: "spawned", pid: c2.pid, at: minutesAgo(41) }, { out: "" });
  ledgerLine({ run_id: "run-old", task: "auth-02.1", status: "done" });
  await ad.reconcile();
  assert.equal(attempts()[0].state, "unknown");
  assert.equal(attempts()[1].state, "done");
  assert.equal(attempts()[1].run_id, "run-old");
  assert.equal(allowance.active(), 0);
  assert.equal(workers().get("auth-01").status, "unknown");
  // 39 minutes is still watched
  addWorker("auth-03");
  const c3 = liveChild();
  craft({ worker_id: "auth-03", state: "spawned", pid: c3.pid, at: minutesAgo(39) }, { out: "" });
  await ad.reconcile();
  assert.equal(allowance.active(), 1);
}));

test("M3 reconcile rebuilds the allowance from exactly the watched attempts", () => rig(async ({ ad, addWorker, craft, allowance, liveChild, deadPid }) => {
  for (const id of ["a-01", "b-01", "c-01"]) addWorker(id);
  craft({ worker_id: "a-01", state: "spawned", pid: liveChild().pid }, { out: "" });
  craft({ worker_id: "b-01", state: "spawned", pid: deadPid() }, { out: "" });
  craft({ worker_id: "c-01", state: "done", run_id: "r" });
  allowance.reserve("stale-id");
  await ad.reconcile();
  assert.equal(allowance.active(), 1);
}, { codex: { max_parallel_jobs: 3 } }));

// ---- R6: a reserved attempt whose child ran ---------------------------------------------------------------------------------------
test("R6 reconcile treats a reserved attempt whose out file has the result line like a spawned one", () => rig(async ({ ad, addWorker, craft, attempts, allowance }) => {
  addWorker("auth-01");
  craft({ worker_id: "auth-01", state: "reserved" }, { out: RESULT("run-res") });
  allowance.reserve("auth-01.1");
  await ad.reconcile();
  assert.equal(attempts()[0].state, "done");
  assert.equal(attempts()[0].run_id, "run-res");
  assert.equal(allowance.active(), 0);
}));

test("R6 a reserved attempt whose out file shows the child ran (output, no result line yet) stays watched; an empty one is not-spawned", () => rig(async ({ ad, addWorker, craft, attempts, allowance }) => {
  addWorker("a-01"); addWorker("b-01");
  craft({ worker_id: "a-01", state: "reserved" }, { out: "", err: "codex-run: started\n" });
  craft({ worker_id: "b-01", state: "reserved" }, { out: "" });
  await ad.reconcile();
  assert.equal(attempts()[0].state, "reserved");
  assert.equal(attempts()[1].state, "blocked");
  assert.equal(allowance.active(), 1);
}, { codex: { max_parallel_jobs: 3 } }));

test("R6 poll() finishes a reserved attempt whose result line has arrived, and leaves a young one without a line alone", () => rig(async ({ ad, addWorker, craft, attempts, allowance }) => {
  addWorker("a-01"); addWorker("b-01");
  craft({ worker_id: "a-01", state: "reserved" }, { out: RESULT("run-a") });
  craft({ worker_id: "b-01", state: "reserved" }, { out: "" });
  allowance.reserve("a-01.1"); allowance.reserve("b-01.1");
  const events = await ad.poll();
  assert.equal(events.filter((x) => x.type === "finished").length, 1);
  assert.equal(attempts()[0].state, "done");
  assert.equal(attempts()[1].state, "reserved");
  assert.equal(allowance.active(), 1);
  // an old one with nothing to show becomes unknown
  craft({ worker_id: "b-01", state: "reserved", at: minutesAgo(45) }, { out: "" });
  await ad.poll();
  assert.equal(attempts()[1].state, "unknown");
  assert.equal(allowance.active(), 0);
}, { codex: { max_parallel_jobs: 3 } }));

// ---- R2: poll() applies the dead-run path -----------------------------------------------------------------------------------------
test("R2 poll() turns a spawned attempt whose process died with no result line and no ledger line into unknown", () => rig(async ({ ad, addWorker, attempts, workers, allowance, pollUntil }) => {
  const w = addWorker("auth-01");
  assert.equal((await ad.start(w, "x", { requestId: "r1" })).started, "auth-01.1");
  assert.equal(allowance.active(), 1);
  const events = await pollUntil((e) => e.some((x) => x.type === "unknown" || x.type === "finished"));
  assert.ok(events.some((x) => x.type === "unknown"), JSON.stringify(events));
  assert.equal(attempts()[0].state, "unknown");
  assert.equal(workers().get("auth-01").status, "unknown");
  assert.equal(allowance.active(), 0);
  assert.deepEqual(await ad.poll(), [], "settled once");
}, { scenario: { die_no_ledger: true } }));

test("R2 poll() persists a dead run from the Codex ledger when the result line is missing", () => rig(async ({ ad, addWorker, attempts, workers, allowance, pollUntil }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "x", { requestId: "r1" });
  await pollUntil((e) => e.some((x) => x.type === "finished"));
  assert.equal(attempts()[0].state, "done");
  assert.ok(attempts()[0].run_id);
  assert.equal(workers().get("auth-01").status, "waiting_for_user");
  assert.equal(allowance.active(), 0);
}, { scenario: { die_without_line: true } }));

test("R2 a live process with no line yet is left alone by poll()", () => rig(async ({ ad, addWorker, attempts, allowance }) => {
  const w = addWorker("auth-01");
  await ad.start(w, "x", { requestId: "r1" });
  for (let i = 0; i < 3; i++) { assert.deepEqual(await ad.poll(), []); await sleep(100); }
  assert.equal(attempts()[0].state, "spawned");
  assert.equal(allowance.active(), 1);
}, { scenario: { delay_ms: 3000 } }));

// ---- Task 10b review fixes -------------------------------------------------------------------------------------------------------
const OLD_BLOCKED = () => RESULT("run-old", { status: "blocked", reason: "worktree-busy" });

for (const [what, files] of [["stdout", { out: OLD_BLOCKED(), err: "" }], ["stderr", { out: "", err: "codex-run: previous run's note\n" }]]) {
  test(`X1 a requeued attempt's files are truncated before its reserved line: a restart never reads the previous run's ${what}`, () => rig(async ({ ad, addWorker, craft, attempts, allowance, spawn, workers }) => {
    addWorker("auth-01");
    const queued = { worker_id: "auth-01", state: "queued", requeues: 1, instruction: "again", result: { run: "run-old", status: "blocked", reason: "worktree-busy" } };
    craft(queued, files);
    const ledger = path.join(stateDir(), "codex-attempts.jsonl");
    fs.chmodSync(ledger, 0o444); // the reserved line cannot be written: the process "crashes" right after the files were opened
    try { await ad.poll(); } finally { fs.chmodSync(ledger, 0o666); }
    assert.equal(spawn.calls.length, 0);
    assert.equal(fs.readFileSync(path.join(stateDir(), "codex-out", "auth-01.1.out"), "utf8"), "", "stdout of the previous run is gone");
    assert.equal(fs.readFileSync(path.join(stateDir(), "codex-out", "auth-01.1.err"), "utf8"), "", "stderr of the previous run is gone");
    // the reserved line did get written in the crash case: the restart must find nothing of the previous run
    craft({ ...queued, state: "reserved" });
    const events = await ad.reconcile();
    assert.ok(events.some((x) => x.type === "blocked" && x.reason === "not-spawned"), JSON.stringify(events));
    assert.equal(attempts()[0].state, "blocked");
    assert.equal(attempts()[0].requeues, 1, "the old result was not consumed (no second requeue)");
    assert.equal(allowance.active(), 0, "no slot rebuilt for a child that never spawned");
    assert.equal(workers().get("auth-01").status, "blocked");
  }));
}

test("X3 follow-ups for a busy worker count against queue_max: a full queue refuses and the running worker keeps its status", () => rig(async ({ ad, addWorker, attempts, workers, spawn }) => {
  const w = addWorker("auth-01");
  assert.ok((await ad.start(w, "first", { requestId: "r1" })).started);
  assert.ok((await ad.start(w, "second", { requestId: "r2" })).queued);
  const lines = store.readJsonl("codex-attempts").length;
  const full = await ad.start(w, "third", { requestId: "r3" });
  assert.equal(full.blocked, "busy", JSON.stringify(full));
  assert.equal(full.reason, "codex-queue-full");
  assert.equal(full.fallback.action, "refuse");
  assert.equal(store.readJsonl("codex-attempts").length, lines, "no attempt line for the refused follow-up");
  assert.equal(workers().get("auth-01").status, "running");
  assert.equal(spawn.calls.length, 1);
  assert.equal(attempts().filter((a) => a.state === "queued").length, 1);
}, { codex: { queue_max: 1 }, scenario: { delay_ms: 1500 } }));

test("X4 a same-task ledger line written before the attempt began is ignored; one inside the 5 s slack counts", () => rig(async ({ ad, addWorker, craft, attempts, deadPid, ledgerLine }) => {
  addWorker("a-01"); addWorker("b-01");
  craft({ worker_id: "a-01", state: "spawned", pid: deadPid() }, { out: "" });
  craft({ worker_id: "b-01", state: "spawned", pid: deadPid() }, { out: "" });
  ledgerLine({ run_id: "run-stale", task: "a-01.1", status: "done", ts: Date.now() - 60000 }); // an earlier run under the same task id
  ledgerLine({ run_id: "run-near", task: "b-01.1", status: "done", ts: Date.now() - 2000 });
  await ad.reconcile();
  assert.equal(attempts()[0].state, "unknown", "the old line is not this run's");
  assert.equal(attempts()[1].state, "done");
  assert.equal(attempts()[1].run_id, "run-near");
}));

test("X5 a pid-less attempt trusts the Codex ledger only once its line is older than 30 s (codex-run prints the result line after it)", () => rig(async ({ mk, addWorker, craft, attempts, allowance, ledgerLine }) => {
  addWorker("auth-01");
  const clock = { t: Date.now() };
  const ad = mk({ deps: { now: () => clock.t } });
  craft({ worker_id: "auth-01", state: "reserved" }, { out: "" });
  allowance.reserve("auth-01.1");
  ledgerLine({ run_id: "run-1", task: "auth-01.1", status: "done", files: ["a.js"], ts: clock.t });
  assert.deepEqual(await ad.poll(), [], "a fresh ledger line: the result line may still arrive");
  assert.equal(attempts()[0].state, "reserved");
  assert.equal(allowance.active(), 1);
  assert.deepEqual(await ad.reconcile(), [], "the restart path waits too");
  assert.equal(allowance.active(), 1);
  clock.t += 25000;
  assert.deepEqual(await ad.poll(), []);
  clock.t += 6000; // 31 s
  const events = await ad.poll();
  assert.ok(events.some((x) => x.type === "finished" && x.run_id === "run-1"), JSON.stringify(events));
  assert.equal(attempts()[0].state, "done");
  assert.equal(allowance.active(), 0);
}));

test("X5 the real result line still wins over the ledger inside the grace window", () => rig(async ({ ad, addWorker, craft, attempts, allowance, ledgerLine }) => {
  addWorker("auth-01");
  craft({ worker_id: "auth-01", state: "reserved" }, { out: RESULT("run-1", { codex_note: "the real note" }) });
  allowance.reserve("auth-01.1");
  ledgerLine({ run_id: "run-1", task: "auth-01.1", status: "done" });
  await ad.poll();
  assert.equal(attempts()[0].state, "done");
  assert.equal(attempts()[0].result.note, "the real note");
}));

// ---- Task 10b re-review fixes ----------------------------------------------------------------------------------------------------
for (const method of ["poll", "reconcile"]) {
  test(`Y2 ${method}: the fresh-ledger grace also holds at the watchdog cutoff (a pid-less attempt older than 40 minutes)`, () => rig(async ({ mk, addWorker, craft, attempts, allowance, ledgerLine }) => {
    for (const id of ["a-01", "b-01"]) addWorker(id);
    const clock = { t: Date.now() };
    const ad = mk({ deps: { now: () => clock.t } });
    craft({ worker_id: "a-01", state: "reserved", at: minutesAgo(45) }, { out: "" });
    craft({ worker_id: "b-01", state: "reserved", at: minutesAgo(45) }, { out: "" });
    allowance.reserve("a-01.1"); allowance.reserve("b-01.1");
    ledgerLine({ run_id: "run-a", task: "a-01.1", status: "done", ts: clock.t });
    ledgerLine({ run_id: "run-b", task: "b-01.1", status: "done", ts: clock.t });
    assert.deepEqual(await ad[method](), [], "the ledger line is fresh: wait for the result line");
    assert.deepEqual(attempts().map((a) => a.state), ["reserved", "reserved"]);
    assert.equal(allowance.active(), 2);
    // the real result line of a-01 arrives within the grace: it wins over the ledger
    fs.writeFileSync(path.join(stateDir(), "codex-out", "a-01.1.out"), RESULT("run-a", { codex_note: "the real note" }));
    clock.t += 10000;
    const events = await ad[method]();
    assert.equal(events.filter((x) => x.type === "finished").length, 1, JSON.stringify(events));
    assert.equal(attempts()[0].state, "done");
    assert.equal(attempts()[0].result.note, "the real note");
    assert.equal(attempts()[1].state, "reserved");
    // after the grace with no result line b-01 settles from the ledger
    clock.t += 21000;
    await ad[method]();
    assert.equal(attempts()[1].state, "done");
    assert.equal(attempts()[1].run_id, "run-b");
    assert.equal(allowance.active(), 0);
  }, { codex: { max_parallel_jobs: 3 } }));
}
