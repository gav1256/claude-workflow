import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { tmpEnv, scenario, FAKE_CODEX, rmrf } from "./helpers.mjs";
import { sandboxArgs, execArgs, cmdFileText } from "../lib/argv.mjs";

// Run the fake: node fake-codex.mjs <args>, with `input` on stdin (stdin is closed after it).
function run(env, args, input = "") {
  const r = spawnSync(process.execPath, [FAKE_CODEX, ...args], {
    env, input, encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// A `codex sandbox ... -- cmd.exe /d /c <file>` call, as lib/argv.mjs builds it.
function sandbox(env, cwd, fileText, name = "check.cmd") {
  const dir = fs.mkdtempSync(path.join(env.root, "sb dir "));
  const file = path.join(dir, name);
  fs.writeFileSync(file, fileText);
  return run(env, sandboxArgs({ profile: ":workspace", cwd, cmdFile: file }));
}

const execCall = (env, cwd, extra = {}) => {
  const runDirPath = path.join(env.root, "run");
  fs.mkdirSync(runDirPath, { recursive: true });
  return {
    runDirPath,
    args: execArgs({
      mode: "write", model: "sol", effort: "medium", cwd, runId: "r1", runDirPath,
      schemaPath: path.join(env.root, "schema.json"), ...extra,
    }),
  };
};

test("--version prints codex-cli <version>; scenario overrides it", () => {
  const env = tmpEnv();
  try {
    assert.equal(run(env, ["--version"]).out.trim(), "codex-cli 0.160.0");
    scenario({ version: "0.159.1" }, env);
    assert.equal(run(env, ["--version"]).out.trim(), "codex-cli 0.159.1");
  } finally { env.cleanup(); }
});

test("features list prints the scenario's feature lines", () => {
  const env = tmpEnv();
  try {
    scenario({ features: ["plugins  stable  true", "apps  stable  true"] }, env);
    const r = run(env, ["features", "list"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.out.trim().split(/\r?\n/), ["plugins  stable  true", "apps  stable  true"]);
  } finally { env.cleanup(); }
});

const readFile = (n) => Array.from({ length: n }, (_, i) =>
  `type "C:\\secret\\f${i}.txt" >nul 2>nul && echo R:${i} || echo D:${i}`).concat("echo END").join("\r\n") + "\r\n";

test("sandbox read check: every target D:<n> then END", () => {
  const env = tmpEnv();
  try {
    const r = sandbox(env, env.root, readFile(3));
    assert.equal(r.code, 0);
    assert.deepEqual(r.out.trim().split(/\r?\n/), ["D:0", "D:1", "D:2", "END"]);
  } finally { env.cleanup(); }
});

test("sandbox read check: readOpen indexes print R:<n>; readGarbage drops END", () => {
  const env = tmpEnv();
  try {
    scenario({ readOpen: [1] }, env);
    assert.deepEqual(sandbox(env, env.root, readFile(3)).out.trim().split(/\r?\n/), ["D:0", "R:1", "D:2", "END"]);
    scenario({ readGarbage: true }, env);
    assert.deepEqual(sandbox(env, env.root, readFile(2)).out.trim().split(/\r?\n/), ["D:0", "D:1"]);
  } finally { env.cleanup(); }
});

test("sandbox gate file: exits 1 unless gateOpen", () => {
  const env = tmpEnv();
  try {
    const gate = cmdFileText("echo probe > codex-gate-probe.txt");
    assert.equal(sandbox(env, env.root, gate).code, 1);
    scenario({ gateOpen: true }, env);
    assert.equal(sandbox(env, env.root, gate).code, 0);
  } finally { env.cleanup(); }
});

test("sandbox runs any other file with the real cmd.exe: quoting, & and exit code round-trip", () => {
  const env = tmpEnv();
  try {
    const r = sandbox(env, env.root, cmdFileText('echo "a b" & echo c'));
    assert.equal(r.code, 0);
    assert.deepEqual(r.out.trim().split(/\r?\n/).map((s) => s.trim()), ['"a b"', "c"]);
    assert.equal(sandbox(env, env.root, cmdFileText("cmd /c exit 7")).code, 7);
    assert.equal(sandbox(env, env.root, cmdFileText("exit /b 3")).code, 3);
    assert.equal(sandbox(env, env.root, cmdFileText("echo ok")).code, 0);
  } finally { env.cleanup(); }
});

test("sandbox honours -C: the file runs with that working directory", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "work dir");
    fs.mkdirSync(cwd);
    const r = sandbox(env, cwd, cmdFileText("cd"));
    assert.equal(r.out.trim().toLowerCase(), cwd.toLowerCase());
  } finally { env.cleanup(); }
});

test("exec: reads stdin to EOF, emits thread.started and turn.completed, exit 0", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    scenario({ threadId: "thread-abc", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }, env);
    const { args } = execCall(env, cwd);
    const r = run(env, args, "the brief\n");
    assert.equal(r.code, 0, r.err);
    const events = r.out.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(events[0], { type: "thread.started", thread_id: "thread-abc" });
    const done = events.find((e) => e.type === "turn.completed");
    assert.deepEqual(done.usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 });
    assert.ok(events.findIndex((e) => e.type === "thread.started") < events.findIndex((e) => e.type === "turn.completed"));
  } finally { env.cleanup(); }
});

test("exec: default thread id is generated; noThread omits thread.started", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    const { args } = execCall(env, cwd);
    const first = JSON.parse(run(env, args, "x").out.trim().split(/\r?\n/)[0]);
    assert.equal(first.type, "thread.started");
    assert.match(first.thread_id, /^[0-9a-f-]{8,}$/);
    scenario({ noThread: true }, env);
    const out = run(env, args, "x").out;
    assert.ok(!out.includes("thread.started"));
    assert.ok(out.includes("turn.completed"));
  } finally { env.cleanup(); }
});

test("exec: records argv and stdin when asked, and applies writes[] into -C", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    const argvFile = path.join(env.root, "argv.json");
    const stdinFile = path.join(env.root, "stdin.txt");
    scenario({
      argvFile, stdinFile,
      writes: [{ path: "a.txt", content: "A\n" }, { path: "sub/deep/b.txt", content: "B\n" }],
    }, env);
    const { args } = execCall(env, cwd);
    assert.equal(run(env, args, "line1\nline2\n").code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(argvFile, "utf8")), args);
    assert.equal(fs.readFileSync(stdinFile, "utf8"), "line1\nline2\n");
    assert.equal(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "A\n");
    assert.equal(fs.readFileSync(path.join(cwd, "sub", "deep", "b.txt"), "utf8"), "B\n");
  } finally { env.cleanup(); }
});

test("exec research: writes land in the research folder given by -C", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    const rdir = path.join(cwd, ".codex-tmp", "r1", "research");
    fs.mkdirSync(rdir, { recursive: true });
    scenario({ writes: [{ path: "note.txt", content: "n" }] }, env);
    const { args } = execCall(env, cwd, { mode: "research" });
    assert.equal(run(env, args, "x").code, 0);
    assert.equal(fs.readFileSync(path.join(rdir, "note.txt"), "utf8"), "n");
  } finally { env.cleanup(); }
});

test("exec: writes the rollout under CODEX_HOME/sessions/YYYY/MM/DD (UTC) with rate limits", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    const rateLimits = {
      primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1790000000 },
      secondary: { used_percent: 3, window_minutes: 10080, resets_at: 1790500000 },
      rate_limit_reached_type: null,
    };
    scenario({ threadId: "t-roll", rateLimits }, env);
    const { args } = execCall(env, cwd);
    assert.equal(run(env, args, "x").code, 0);
    const now = new Date();
    const day = [String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), String(now.getUTCDate()).padStart(2, "0")];
    const dayDir = path.join(env.CODEX_HOME, "sessions", ...day);
    assert.ok(fs.existsSync(dayDir), `no rollout folder ${dayDir}`);
    const files = fs.readdirSync(dayDir).filter((f) => /^rollout-.+-t-roll\.jsonl$/.test(f));
    assert.equal(files.length, 1, fs.readdirSync(dayDir).join(","));
    const lines = fs.readFileSync(path.join(dayDir, files[0]), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const tc = lines.filter((l) => l.payload?.type === "token_count").pop();
    assert.deepEqual(tc.payload.rate_limits, rateLimits);
  } finally { env.cleanup(); }
});

test("exec: rolloutDay overrides the folder; noRollout skips it", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    scenario({ rolloutDay: "2026-01-02", threadId: "t-day" }, env);
    const { args } = execCall(env, cwd);
    run(env, args, "x");
    const dir = path.join(env.CODEX_HOME, "sessions", "2026", "01", "02");
    assert.ok(fs.readdirSync(dir).some((f) => f.endsWith("-t-day.jsonl")));
    scenario({ noRollout: true, threadId: "t-none" }, env);
    run(env, args, "x");
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith("-t-none.jsonl")));
  } finally { env.cleanup(); }
});

test("exec: lastJson string goes verbatim to -o (even invalid); absent means no file", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    const { args, runDirPath } = execCall(env, cwd);
    const out = path.join(runDirPath, "last.json");
    run(env, args, "x");
    assert.ok(!fs.existsSync(out));
    scenario({ lastJson: '{"status":"ok"}' }, env);
    run(env, args, "x");
    assert.equal(fs.readFileSync(out, "utf8"), '{"status":"ok"}');
    scenario({ lastJson: "{not json" }, env);
    run(env, args, "x");
    assert.equal(fs.readFileSync(out, "utf8"), "{not json");
  } finally { env.cleanup(); }
});

test("exec: exits with scenario.exit", () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    scenario({ exit: 5 }, env);
    assert.equal(run(env, execCall(env, cwd).args, "x").code, 5);
  } finally { env.cleanup(); }
});

test("exec: fails when stdin never closes", async () => {
  const env = tmpEnv();
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    scenario({ stdinTimeoutMs: 400 }, env);
    const child = spawn(process.execPath, [FAKE_CODEX, ...execCall(env, cwd).args],
      { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.notEqual(code, 0);
    assert.match(err, /stdin/i);
  } finally { env.cleanup(); }
});

test("exec: sleepMs with a grandchild: both are alive while the fake sleeps", async () => {
  const env = tmpEnv();
  let grandchild;
  try {
    const cwd = path.join(env.root, "wt");
    fs.mkdirSync(cwd);
    const pidFile = path.join(env.root, "pids.json");
    scenario({ sleepMs: 60000, grandchild: true, pidFile }, env);
    const child = spawn(process.execPath, [FAKE_CODEX, ...execCall(env, cwd).args],
      { env, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.stdin.end("x");
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    grandchild = pids.grandchild;
    assert.equal(pids.pid, child.pid);
    assert.ok(Number.isInteger(grandchild) && grandchild !== child.pid);
    process.kill(grandchild, 0); // alive (throws if not)
    process.kill(child.pid, 0);
    child.kill();
    await new Promise((resolve) => child.on("exit", resolve));
    // (libuv puts the fake in a kill-on-close job object, so the grandchild normally dies with it;
    // the finally block still kills it by pid in case it does not)
  } finally {
    if (grandchild) { try { process.kill(grandchild); } catch { /* already gone */ } }
    env.cleanup();
  }
});

test("unknown subcommand exits 2", () => {
  const env = tmpEnv();
  try {
    assert.equal(run(env, ["frobnicate"]).code, 2);
  } finally { env.cleanup(); }
});
