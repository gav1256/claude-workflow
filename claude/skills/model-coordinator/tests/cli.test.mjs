// Task 13: the coordinator CLI. Every test runs cli.mjs (or a small runner that imports main) in a CHILD process with the
// handoff-launch sandbox env (HL_NO_SPAWN=1, HL_FAKE_CLAUDE=1, a fake agents list, a temp registry and CLAUDE_CONFIG_DIR), a
// unique pipe name, and a fake `codex login status` CLI. Nothing real starts: no window, no claude, no Codex run, no API call.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { SKILL_DIR, FAKE_CODEX_CLI, withEnv, seedWorker } from "./mc-helpers.mjs";
import { sandbox, sessionLine, setAgents, launchLane, appendLine } from "../../handoff-launch/tests/helpers.mjs";
import { acquireInstance, releaseInstance } from "../instance.mjs";
import { selectRestart } from "../cli.mjs";
import { msgKey } from "../paths.mjs";

const CLI = path.join(SKILL_DIR, "cli.mjs");
const CRED = /^(openai_api_key|codex_api_key|codex_run_env_allow)$/i;
let counter = 0;

const state = (sb) => path.join(sb.cfg, "state", "model-coordinator");
const withSb = (fn, opts) => async () => { const sb = sandbox(opts); try { await fn(sb); } finally { sb.cleanup(); } };

/** The sandbox env for a CLI child: a unique pipe, the fake codex login CLI, no credentials unless `extra` adds them. */
function cliEnv(sb, extra = {}) {
  const k = ++counter, env = {};
  for (const [name, v] of Object.entries(sb.env)) if (!CRED.test(name)) env[name] = v;
  return {
    ...env, MC_PIPE_NAME: `mc-cli-${process.pid}-${k}`, CODEX_RUN_PIPE_PREFIX: `codex-run-mccli-${process.pid}-${k}-`,
    CODEX_RUN_BIN: process.execPath, CODEX_RUN_BIN_ARGS: JSON.stringify([FAKE_CODEX_CLI]), FAKE_LOGIN: "none", ...extra,
  };
}

/** Runs `node cli.mjs ...args` in the sandbox repo. stdin is ignored unless `input` is given (then it is piped and closed). */
function runCli(sb, args, { env = cliEnv(sb), input = null, cwd = sb.repo } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env, cwd, encoding: "utf8", windowsHide: true, timeout: 60000,
    ...(input === null ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });
  assert.equal(r.error, undefined, String(r.error));
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
}

/**
 * Runs main() in a child with injected deps: `argv`, `lines` (the REPL's stdin, each followed by a newline; `delayed` lines go in
 * once the output matches `waitFor`, a regex source), `launch` ("spy": record only | "real": record, then run launch.mjs), `body` (extra deps source, e.g. a fake
 * codex adapter). The child prints @@RESULT@@{code, out, err, calls, procCreds, ...}.
 */
function runMain(sb, { argv, lines = [], delayed = [], waitFor = null, launch = "spy", pre = "", body = "", env = cliEnv(sb), post = "" }) {
  const file = path.join(sb.tmp, `runner-${++counter}.mjs`);
  fs.writeFileSync(file, [
    `import { Readable } from "node:stream";`,
    `import { main, defaultRunLaunch } from ${JSON.stringify(pathToFileURL(CLI).href)};`,
    `const out = [], err = [], calls = [];`,
    `const input = new Readable({ read() {} });`,
    `for (const l of ${JSON.stringify(lines)}) input.push(l + "\\n");`,
    `const release = () => { for (const l of ${JSON.stringify(delayed)}) input.push(l + "\\n"); setTimeout(() => input.push(null), 100); };`,
    `if (${delayed.length}) { const t0 = Date.now(), w = setInterval(() => { if (${waitFor ? `${waitFor}.test(out.join(""))` : "true"} || Date.now() - t0 > 20000) { clearInterval(w); release(); } }, 20); } else input.push(null);`,
    `const runLaunch = (args, opts) => { calls.push({ args, envKeys: Object.keys(opts?.env ?? {}), env: Object.fromEntries(Object.entries(opts?.env ?? {}).filter(([k]) => /^HL_(REGISTRY_DIR|NO_SPAWN|MODEL_COORDINATOR)$/.test(k))) });`,
    `  return ${launch === "real" ? "defaultRunLaunch(args, opts)" : `{ status: 0, stdout: "spy: not run\\n", stderr: "" }`}; };`,
    pre,
    `const deps = { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, input, runLaunch, ${body} };`,
    `const code = await main(${JSON.stringify(argv)}, deps);`,
    `const extra = await (async () => { ${post} })();`,
    `const procCreds = Object.keys(process.env).filter((k) => /^(openai_api_key|codex_api_key|codex_run_env_allow)$/i.test(k));`,
    `console.log("@@RESULT@@" + JSON.stringify({ code, out: out.join(""), err: err.join(""), calls, procCreds, extra }));`,
  ].join("\n"));
  const r = spawnSync(process.execPath, [file], { env, cwd: sb.repo, encoding: "utf8", windowsHide: true, timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.error, undefined, String(r.error));
  const m = /@@RESULT@@(.*)$/m.exec(r.stdout || "");
  assert.ok(m, `runner failed (exit ${r.status}): ${r.stderr}\n${r.stdout}`);
  return { ...JSON.parse(m[1]), stderr: r.stderr || "" };
}

/** A live bg lane (the registry and the fake agents list know it) plus its worker record. */
function liveWorker(sb, id, { sid = `s-${id}`, bg = `b-${id}`, status = "busy", extra = {}, worker = {} } = {}) {
  sessionLine(sb, { name: id, mode: "bg", bg_id: bg, sid });
  const cur = JSON.parse(fs.readFileSync(path.join(sb.tmp, "agents.json"), "utf8"));
  setAgents(sb, [...cur.filter((a) => a.id !== bg), { id: bg, sessionId: sid, name: id, status }]);
  return withEnv(sb.env, () => seedWorker(id, "claude", { lane: id, status: "running", ...worker, extra: { ...(worker.extra ?? {}), ...extra } }));
}
const pendingFiles = (sb, lane) => { try { return fs.readdirSync(path.join(state(sb), "messages", msgKey(lane))).sort(); } catch { return []; } };
const writeConfig = (sb, obj) => { fs.mkdirSync(state(sb), { recursive: true }); fs.writeFileSync(path.join(state(sb), "config.json"), JSON.stringify(obj)); };
const workersLedger = (sb) => { try { return fs.readFileSync(path.join(state(sb), "workers.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** A lane that crashed a while ago: launched through launch.mjs (HL_NO_SPAWN), then its launch lines aged past the 5 min in-flight guard. */
function crashedLane(sb, name) {
  launchLane(sb, "g1", name);
  const f = path.join(sb.reg, "sessions.jsonl"), old = (t) => new Date(Date.parse(t) - 10 * 60000).toISOString();
  const lines = fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const o = JSON.parse(l);
    if (o.name === name && o.launched_at) o.launched_at = old(o.launched_at); else if (o.name === name && "starting" in o) o.at = old(o.at);
    return JSON.stringify(o);
  });
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return sb.registry().find((x) => x.name === name && x.launched_at).id;
}
const realRegistry = path.join(SKILL_DIR, "..", "handoff-launch", "sessions.jsonl");
const statReal = () => { try { const s = fs.statSync(realRegistry); return `${s.size}:${s.mtimeMs}`; } catch { return "absent"; } };

// ---- M7 / K1 -----------------------------------------------------------------------------------------------------------
test("M7 coordinator.cmd holds no absolute personal path and runs skills\\model-coordinator\\cli.mjs", () => {
  const text = fs.readFileSync(path.join(SKILL_DIR, "coordinator.cmd"), "utf8");
  assert.doesNotMatch(text, /[A-Z]:\\Users\\/i);
  assert.ok(text.includes("skills\\model-coordinator\\cli.mjs"));
  assert.match(text, /CLAUDE_CONFIG_DIR/);
  assert.match(text, /%\*/);
});

test("K1 cli.mjs imports ConfigError from provider.mjs and defines no second one", () => {
  const src = fs.readFileSync(CLI, "utf8");
  assert.match(src, /import \{[^}]*\bConfigError\b[^}]*\} from "\.\/provider\.mjs"/);
  assert.doesNotMatch(src, /class\s+ConfigError/);
});

// ---- M6 / K2 -----------------------------------------------------------------------------------------------------------
test("M6 a sonnet Claude model in the config prints the reason and exits 2", withSb((sb) => {
  writeConfig(sb, { claude: { model: "sonnet" } });
  const r = runCli(sb, ["--once", "/status"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /claude\.model: sonnet and haiku Claude workers are not allowed/);
  assert.equal(r.out.trim(), "", "nothing ran");
}));

test("K2 every config error is printed, a mistyped value included (it never silently becomes a default), and --status refuses too", withSb((sb) => {
  writeConfig(sb, { provider: "opnai", codex: { max_parallel_jobs: 9 } });
  for (const args of [["--once", "/status"], ["--status"], []]) {
    const r = runCli(sb, args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, /provider: must be "none" or "openai"/);
    assert.match(r.err, /codex\.max_parallel_jobs: must be an integer from 1 to 3/);
  }
  assert.ok(!fs.existsSync(path.join(state(sb), "instance.json")), "no instance was taken");
}));

test("K6 the mock provider cannot be chosen from the config", withSb((sb) => {
  writeConfig(sb, { provider: "mock" });
  const r = runCli(sb, ["--once", "hello"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /provider: must be "none" or "openai"/);
}));

// ---- M1 ----------------------------------------------------------------------------------------------------------------
test("M1 a second instance prints already running (pid ...) and exits 1; the first is unaffected", withSb(async (sb) => {
  const env = cliEnv(sb);
  const first = await withEnv(env, () => acquireInstance(env.MC_PIPE_NAME));
  try {
    const file = path.join(state(sb), "instance.json"), before = fs.readFileSync(file, "utf8");
    const r = runCli(sb, ["--once", "/status"], { env });
    assert.equal(r.code, 1);
    const text = r.out + r.err;
    assert.ok(text.includes(`coordinator already running (pid ${process.pid}, since ${JSON.parse(before).started_at})`), text);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    assert.equal(first.server.listening, true);
    const s = runCli(sb, ["--status"], { env }); // a status read never needs the instance
    assert.equal(s.code, 0, s.err);
  } finally { await releaseInstance(first.server); }
}));

test("the instance is released when the CLI ends: a second run right after works", withSb((sb) => {
  const env = cliEnv(sb);
  assert.equal(runCli(sb, ["--once", "/status"], { env }).code, 0);
  assert.equal(runCli(sb, ["--once", "/status"], { env }).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state(sb), "instance.json"), "utf8")).pid > 0, true);
}));

// ---- M2 ----------------------------------------------------------------------------------------------------------------
test("M2 --once /to <id> hi delivers to the live bg lane, names the path, exits 0 and leaves one message file", withSb(async (sb) => {
  await liveWorker(sb, "w-01");
  const r = runCli(sb, ["--once", "/to w-01 hi there"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /w-01: delivered at its next tool call/);
  const files = pendingFiles(sb, "w-01");
  assert.equal(files.length, 1, files.join());
  assert.match(files[0], /^[0-9a-f]{32}\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state(sb), "messages", msgKey("w-01"), files[0]), "utf8")).text, "hi there");
}));

// ---- M3 ----------------------------------------------------------------------------------------------------------------
test("M3 --status --json prints the workers, the cost and the Codex resource state", withSb(async (sb) => {
  await liveWorker(sb, "w-01");
  const r = runCli(sb, ["--status", "--json"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j).sort(), ["codex", "cost", "workers"]);
  assert.deepEqual(j.workers.map((w) => w.id), ["w-01"]);
  assert.deepEqual(Object.keys(j.cost).sort(), ["hard", "soft", "spent_usd", "state"]);
  assert.equal(j.cost.state, "ok");
  assert.deepEqual(Object.keys(j.codex).sort(), ["active_jobs", "available", "capacity_available", "max_parallel_jobs", "usage_status"]);
  assert.equal(j.codex.available, false, "the fake login says not logged in");
  assert.equal(j.codex.max_parallel_jobs, 2);
  const t = runCli(sb, ["--status"]);
  assert.equal(t.code, 0);
  assert.match(t.out, /w-01 \(claude\)/);
  assert.match(t.out, /Cost:/);
  assert.match(t.out, /Codex:/);
}));

// ---- M5 / K6 / K7 -------------------------------------------------------------------------------------------------------
test("M5 with provider none an ambiguous line replies Luna is unavailable (no-provider: ...); /to still works", withSb(async (sb) => {
  await liveWorker(sb, "w-01");
  const a = runCli(sb, ["--once", "please look into the flaky thing"]);
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /^Luna is unavailable \(no-provider: /m);
  const b = runCli(sb, ["--once", "/to w-01 hello"]);
  assert.match(b.out, /w-01: delivered/);
}));

test("K6 provider openai without a key or a price table falls back to NullProvider with a notice", withSb((sb) => {
  writeConfig(sb, { provider: "openai" });
  const r = runCli(sb, ["--once", "please look into the flaky thing"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out + r.err, /Luna provider not started: no complete price table/);
  assert.match(r.out, /^Luna is unavailable \(no-provider: /m);
  writeConfig(sb, { provider: "openai", pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4 } } });
  const k = runCli(sb, ["--once", "please look into the flaky thing"]);
  assert.match(k.out + k.err, /Luna provider not started: no OpenAI key/);
  assert.match(k.out, /^Luna is unavailable \(no-provider: /m);
}));


test("K7 after startup no credential name is in process.env, and the provider still has the key", withSb((sb) => {
  writeConfig(sb, { provider: "openai", pricing: { "gpt-6-luna": { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 4 } } });
  const decision = { action: "respond", target_session_ids: [], worker_instruction: null, reply: "all quiet", clarification: null, confidence: 0.9,
    new_session: { needed: false, provider: null, label: null, objective: null }, record_update: null };
  const body = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision) }] }],
    usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } };
  const env = cliEnv(sb, { Openai_Api_Key: "sk-test-FAKE-KEY-0123", CODEX_API_KEY: "ck-fake", Codex_Run_Env_Allow: "X" });
  const r = runMain(sb, {
    argv: ["--once", "please look into the flaky thing"], env,
    pre: `const seen = [];`,
    body: `fetch: async (url, init) => { seen.push({ url, auth: init.headers.Authorization, procCreds: Object.keys(process.env).filter((k) => /^(openai_api_key|codex_api_key|codex_run_env_allow)$/i.test(k)) });
      return { status: 200, headers: { get: () => null }, text: async () => ${JSON.stringify(JSON.stringify(body))} }; }`,
    post: "return seen;",
  });
  assert.equal(r.code, 0, r.err + r.stderr);
  assert.match(r.out, /all quiet/);
  assert.deepEqual(r.procCreds, [], "no credential name is left in process.env");
  assert.equal(r.extra.length, 1, "one request went to the (fake) API");
  assert.equal(r.extra[0].auth, "Bearer sk-test-FAKE-KEY-0123", "the provider kept the key it read");
  assert.deepEqual(r.extra[0].procCreds, [], "already gone while the provider ran");
  assert.equal(r.extra[0].url, "https://api.openai.com/v1/responses");
  // the usage ledger holds counts and cost only, never the key
  assert.doesNotMatch(fs.readFileSync(path.join(state(sb), "usage.jsonl"), "utf8"), /sk-test/);
}));

// ---- M4 / K4 / K9 -------------------------------------------------------------------------------------------------------
const recorded = (r) => r.calls.map((c) => c.args);

test("M4 startup with a crashed lane and --yes runs resume --closed --all under launchEnv(); the sandbox registry gets the new line", withSb((sb) => {
  const old = crashedLane(sb, "crashed-lane");
  const before = statReal(), regBefore = sb.registry().length;
  const env = cliEnv(sb, { Openai_Api_Key: "x" }); // mixed case on purpose: every strip is case-insensitive
  const r = runMain(sb, { argv: ["--yes", "--once", "/status"], launch: "real", env });
  assert.equal(r.code, 0, r.err + r.stderr);
  assert.deepEqual(recorded(r), [["resume", "--closed", "--all"]]);
  const c = r.calls[0];
  assert.ok(c.envKeys.includes("HL_REGISTRY_DIR") && c.envKeys.includes("HL_NO_SPAWN"), c.envKeys.join());
  assert.equal(c.env.HL_MODEL_COORDINATOR, "1");
  assert.ok(!c.envKeys.some((k) => CRED.test(k)), "no credential in the launch env, in any case");
  assert.deepEqual(r.procCreds, []);
  assert.match(r.out, /reopen crashed-lane/);
  const again = sb.registry();
  assert.ok(again.length > regBefore);
  assert.ok(again.some((x) => x.launched_at && x.supersedes === old), "a new launch line supersedes the crashed one");
  assert.equal(statReal(), before, "the real registry is untouched");
}));

test("M4 with --no nothing is launched; with neither flag and no terminal nothing is asked", withSb((sb) => {
  crashedLane(sb, "crashed-lane");
  const n = sb.registry().length;
  const a = runMain(sb, { argv: ["--no", "--once", "/status"], launch: "real" });
  assert.deepEqual(recorded(a), []);
  assert.equal(sb.registry().length, n);
  const b = runMain(sb, { argv: ["--once", "/status"], launch: "real" });
  assert.deepEqual(recorded(b), []);
  const c = runMain(sb, { argv: [], lines: ["/quit"], launch: "real" });
  assert.deepEqual(recorded(c), [], "a REPL without a terminal never asks");
  assert.equal(c.code, 0);
  assert.equal(sb.registry().length, n);
}));

test("K4 /restart-closed runs the same resume --closed --all path through runLaunch with launchEnv(), and /quit ends the REPL", withSb((sb) => {
  crashedLane(sb, "crashed-lane");
  const r = runMain(sb, { argv: [], lines: ["/restart-closed", "/quit"] });
  assert.equal(r.code, 0, r.err + r.stderr);
  assert.deepEqual(recorded(r), [["resume", "--closed", "--all"]]);
  assert.ok(r.calls[0].envKeys.includes("HL_REGISTRY_DIR"));
  assert.ok(!r.calls[0].envKeys.some((k) => CRED.test(k)));
  assert.match(r.out, /Reopening closed sessions/);
  assert.match(r.out, /spy: not run/);
  assert.match(r.out, /Leaving the coordinator/);
}));

test("K4 /restart-closed with nothing closed says so and launches nothing", withSb((sb) => {
  const r = runMain(sb, { argv: [], lines: ["/restart-closed", "/quit"] });
  assert.deepEqual(recorded(r), []);
  assert.match(r.out, /No closed sessions to reopen/);
}));

test("K9 a dead lane whose worktree a live --in worker uses is skipped with the reason, on /restart-closed and at startup", withSb(async (sb) => {
  const idA = crashedLane(sb, "auth-01"), idB = crashedLane(sb, "other-01");
  await liveWorker(sb, "fix-01", { worker: { extra: { in_worktree_of: "auth-01" } } });
  await withEnv(sb.env, () => seedWorker("auth-01", "claude", { lane: "auth-01", status: "running" }));
  const r = runMain(sb, { argv: ["--yes", "--once", "/restart-closed"] });
  assert.equal(r.code, 0, r.err + r.stderr);
  // startup and the command each reopen only the other lane, by id (never --all, which would reopen auth-01 too)
  assert.deepEqual(recorded(r), [["resume", "--closed", "--id", idB], ["resume", "--closed", "--id", idB]]);
  assert.ok(!recorded(r).some((a) => a.includes(idA)));
  assert.match(r.out, /skipped auth-01: fix-01 is working in its worktree/);
}));

test("K9 when every closed lane is held by a live --in worker nothing is launched", withSb(async (sb) => {
  crashedLane(sb, "auth-01");
  await liveWorker(sb, "fix-01", { worker: { extra: { in_worktree_of: "auth-01" } } });
  const r = runMain(sb, { argv: ["--yes", "--once", "/status"] });
  assert.deepEqual(recorded(r), []);
  assert.match(r.out, /skipped auth-01: fix-01 is working in its worktree/);
}));

test("K9 selectRestart: only a non-finished worker with in_worktree_of = the lane (its name, id or the referenced worker's lane) holds it", () => {
  const rows = [{ id: "a@1", name: "auth-01" }, { id: "b@1", name: "other-01" }, { id: "c@1", name: "third-01" }];
  const ws = [
    { id: "auth-01", lane: "auth-01", status: "dead" },
    { id: "fix-01", lane: "fix-01", status: "running", in_worktree_of: "auth-01" },
    { id: "done-01", lane: "done-01", status: "finished", in_worktree_of: "other-01" },
    { id: "x-01", lane: "x-01", status: "idle", in_worktree_of: "t3" },
    { id: "t3", lane: "third-01", status: "finished" },
  ];
  const s = selectRestart(rows, ws);
  assert.deepEqual(s.restart.map((r) => r.name), ["other-01"]);
  assert.deepEqual(s.skipped.map((x) => [x.row.name, x.holder.id]), [["auth-01", "fix-01"], ["third-01", "x-01"]]);
  assert.deepEqual(selectRestart(rows, []).restart, rows);
});

// ---- K3 / K8 -------------------------------------------------------------------------------------------------------------
test("K3 lines are processed strictly in order; /quit waits for the lines before it and drops the ones after", withSb(async (sb) => {
  await liveWorker(sb, "w-01");
  const r = runMain(sb, { argv: [], lines: ["/to w-01 one", "/to w-01 two", "/status", "/quit", "/to w-01 late"] });
  assert.equal(r.code, 0, r.err + r.stderr);
  const first = r.out.indexOf("w-01: delivered");
  assert.ok(first >= 0);
  const second = r.out.indexOf("w-01: delivered", first + 5);
  assert.ok(second > first, "two deliveries");
  const status = r.out.lastIndexOf("w-01 (claude)"); // the startup banner lists it too
  assert.ok(status > second, "/status comes after both");
  assert.ok(r.out.indexOf("Leaving the coordinator") > status, "/quit comes last");
  assert.equal(pendingFiles(sb, "w-01").length, 2, "the line after /quit was never processed");
  const texts = pendingFiles(sb, "w-01").map((f) => JSON.parse(fs.readFileSync(path.join(state(sb), "messages", msgKey("w-01"), f), "utf8")).text);
  assert.deepEqual(texts.sort(), ["one", "two"]);
}));

test("K3 end of input finishes the queued lines before exiting 0", withSb(async (sb) => {
  await liveWorker(sb, "w-01");
  const r = runMain(sb, { argv: [], lines: ["/to w-01 one", "/to w-01 two", "/to w-01 three"] });
  assert.equal(r.code, 0);
  assert.equal(pendingFiles(sb, "w-01").length, 3);
}));

test("K3 the poll timer prints a worker completion notice above the prompt once, and the next reply does not repeat it", withSb((sb) => {
  const r = runMain(sb, {
    argv: [], delayed: ["/workers"], waitFor: "/x-01: done - all good/",
    pre: `let polled = 0;
      const fakeCodex = { reconcile: async () => [], poll: async () => (polled++ === 0 ? [{ type: "finished", worker_id: "x-01", status: "done", summary: "all good" }] : []),
        status: () => ({ status: "unknown" }), ensureWorktree: () => ({ ok: false }), start: async () => ({ clarify: "no" }) };`,
    body: `codex: fakeCodex, pollMs: 60`,
  });
  assert.equal(r.code, 0, r.err + r.stderr);
  assert.equal(r.out.split("x-01: done - all good").length - 1, 1, r.out);
  assert.ok(r.out.indexOf("x-01: done - all good") < r.out.lastIndexOf("No workers yet."), "the notice came from the timer, before the line was read");
}));

test("K8 a repeated /new line is a new turn: while the label is live it gets the label-in-use reply, never the stored result of the first", withSb(async (sb) => {
  await liveWorker(sb, "demo-lane-01");
  const r = runMain(sb, { argv: [], lines: ["/new claude demo-lane build the thing", "/new claude demo-lane build the thing", "/quit"] });
  assert.equal(r.code, 0, r.err + r.stderr);
  assert.equal((r.out.match(/Cannot do that: label-in-use new_session\.label \(demo-lane\)/g) ?? []).length, 2, r.out);
  assert.doesNotMatch(r.out, /Started claude worker/);
  assert.equal(workersLedger(sb).filter((e) => e.ev === "created").length, 1, "no second worker");
}));

test("K8 under HL_NO_SPAWN the first /new lane is dead at once, so the repeat is a fresh create (demo-lane-02), not a replay of demo-lane-01", withSb((sb) => {
  const r = runMain(sb, { argv: [], lines: ["/new claude demo-lane build the thing", "/new claude demo-lane build the thing", "/quit"], launch: "real" });
  assert.equal(r.code, 0, r.err + r.stderr);
  assert.equal((r.out.match(/Started claude worker demo-lane-01/g) ?? []).length, 1, r.out);
  assert.match(r.out, /Started claude worker demo-lane-02/);
  assert.ok(sb.registry().some((x) => x.name === "demo-lane-01" && x.launched_at), "the first one was really launched (HL_NO_SPAWN)");
}));

// ---- the repo ------------------------------------------------------------------------------------------------------------
test("a create outside a git repo (no --repo) replies to start the coordinator inside one; --repo makes it work", withSb((sb) => {
  const plain = path.join(sb.tmp, "plain");
  fs.mkdirSync(plain);
  const a = runCli(sb, ["--once", "/new claude demo-lane build the thing"], { cwd: plain });
  assert.equal(a.code, 0, a.err);
  assert.match(a.out, /start the coordinator inside a git repo or pass --repo/);
  assert.equal(workersLedger(sb).length, 0, "nothing was recorded");
  const b = runCli(sb, ["--repo", sb.repo, "--once", "/new claude demo-lane build the thing"], { cwd: plain });
  assert.match(b.out, /Started claude worker demo-lane-01/);
}));

test("bad arguments exit 2 with a usage line", withSb((sb) => {
  for (const args of [["--bogus"], ["--once"], ["--yes", "--no"], ["--repo"], ["--status", "--once", "x"]]) {
    const r = runCli(sb, args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.err, /usage:|unknown option|needs|choose/i);
  }
  assert.equal(runCli(sb, ["--help"]).code, 0);
}));
