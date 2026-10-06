// A fake `codex` for tests, injected through CODEX_RUN_BIN (+ CODEX_RUN_BIN_ARGS).
// Behaviour comes from the JSON file named by FAKE_CODEX_SCENARIO (default: {}).
//
//   --version                 prints "codex-cli <scenario.version|0.160.0>"
//   features list             prints scenario.features (array of lines)
//   sandbox ... -- cmd /d /c <file>
//       file has `echo R:<n>` lines (read check): prints D:<n> per target (R:<n> for indexes in
//         scenario.readOpen), then END (scenario.readGarbage drops END)
//       file contains `codex-gate-`: exit 1 unless scenario.gateOpen
//       else: runs the file with the real cmd.exe (in -C) and propagates its exit code
//   exec ...                  reads stdin to EOF (exit 3 if it is not closed within
//       scenario.stdinTimeoutMs, default 15000), then in order:
//       thread.started{thread_id} event (unless scenario.noThread; id = scenario.threadId|random),
//       scenario.writes [{path, content}] into -C (relative to -C; mkdir -p),
//       turn.completed{usage} event (scenario.usage),
//       rollout CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl with a token_count event
//         carrying scenario.rateLimits (UTC day; scenario.rolloutDay "YYYY-MM-DD" overrides;
//         scenario.noRollout skips it),
//       scenario.lastJson (string, written verbatim, may be invalid) to -o,
//       sleeps scenario.sleepMs (with a spawned grandchild node when scenario.grandchild),
//       exits scenario.exit (default 0).
//   Recording knobs for tests: scenario.argvFile (JSON array of the argv), scenario.stdinFile
//   (the stdin text), scenario.pidFile ({pid, grandchild}).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
let sc = {};
try {
  if (process.env.FAKE_CODEX_SCENARIO) sc = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_SCENARIO, "utf8"));
} catch (e) {
  process.stderr.write(`fake-codex: bad scenario: ${e.message}\n`);
  process.exit(4);
}

const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const write = (stream, text) => new Promise((resolve) => stream.write(text, resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (argv[0] === "--version") {
    await write(process.stdout, `codex-cli ${sc.version ?? "0.160.0"}\n`);
    return 0;
  }
  if (argv[0] === "features" && argv[1] === "list") {
    for (const line of sc.features ?? []) await write(process.stdout, line + "\n");
    return 0;
  }
  if (argv[0] === "sandbox") return sandbox();
  if (argv.includes("exec")) return exec();
  await write(process.stderr, `fake-codex: unknown command: ${argv.join(" ")}\n`);
  return 2;
}

async function sandbox() {
  const dd = argv.indexOf("--");
  const file = dd >= 0 ? argv[argv.length - 1] : undefined;
  if (!file) {
    await write(process.stderr, "fake-codex: sandbox needs `-- cmd.exe /d /c <file>`\n");
    return 2;
  }
  const text = fs.readFileSync(file, "utf8");
  const targets = [...text.matchAll(/echo R:(\d+)/g)].map((m) => Number(m[1]));
  if (targets.length) {
    const open = new Set(sc.readOpen ?? []);
    let out = "";
    for (const n of targets) out += `${open.has(n) ? "R" : "D"}:${n}\n`;
    if (!sc.readGarbage) out += "END\n";
    await write(process.stdout, out);
    return 0;
  }
  if (text.includes("codex-gate-")) return sc.gateOpen ? 0 : 1;
  const cmdExe = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const r = spawnSync(cmdExe, ["/d", "/c", file], {
    cwd: flag("-C") || process.cwd(), stdio: "inherit", windowsHide: true,
  });
  return r.status ?? 1;
}

function readStdin(timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(() => reject(new Error("stdin never closed")), timeoutMs);
    process.stdin.on("data", (d) => chunks.push(d));
    process.stdin.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    process.stdin.on("error", reject);
  });
}

async function exec() {
  if (sc.argvFile) fs.writeFileSync(sc.argvFile, JSON.stringify(argv));
  let stdin;
  try {
    stdin = await readStdin(sc.stdinTimeoutMs ?? 15000);
  } catch (e) {
    await write(process.stderr, `fake-codex: ${e.message}\n`);
    return 3;
  }
  if (sc.stdinFile) fs.writeFileSync(sc.stdinFile, stdin);

  const threadId = sc.threadId ?? crypto.randomUUID();
  if (!sc.noThread) {
    await write(process.stdout, JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n");
  }

  const cdir = flag("-C") || process.cwd();
  for (const w of sc.writes ?? []) {
    const target = path.resolve(cdir, w.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, w.content ?? "");
  }

  await write(process.stdout, JSON.stringify({ type: "turn.started" }) + "\n");
  await write(process.stdout, JSON.stringify({
    type: "turn.completed",
    usage: sc.usage ?? { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
  }) + "\n");

  if (!sc.noRollout) writeRollout(threadId);

  const out = flag("-o");
  if (out && sc.lastJson !== undefined) fs.writeFileSync(out, typeof sc.lastJson === "string" ? sc.lastJson : JSON.stringify(sc.lastJson));

  let grandchild;
  if (sc.grandchild) {
    const gc = spawn(process.execPath, ["-e", "setTimeout(()=>{},1e9)"], { stdio: "ignore", windowsHide: true });
    gc.unref();
    grandchild = gc.pid;
  }
  if (sc.pidFile) fs.writeFileSync(sc.pidFile, JSON.stringify({ pid: process.pid, grandchild }));
  if (sc.sleepMs) await sleep(sc.sleepMs);
  return sc.exit ?? 0;
}

function writeRollout(threadId) {
  const home = process.env.CODEX_HOME;
  if (!home) return;
  const now = new Date();
  const iso = now.toISOString(); // UTC
  const day = (sc.rolloutDay ?? iso.slice(0, 10)).split("-");
  const dir = path.join(home, "sessions", day[0], day[1], day[2]);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = iso.slice(0, 19).replace(/:/g, "-"); // 2026-10-06T10-15-00
  const rateLimits = sc.rateLimits ?? {
    primary: { used_percent: 1, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 18000 },
    secondary: { used_percent: 1, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 604800 },
    rate_limit_reached_type: null,
  };
  const lines = [
    { timestamp: iso, type: "session_meta", payload: { id: threadId } },
    { timestamp: iso, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rateLimits } },
  ];
  fs.writeFileSync(path.join(dir, `rollout-${stamp}-${threadId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

main().then((code) => process.exit(code), (e) => {
  process.stderr.write(`fake-codex: ${e?.stack ?? e}\n`);
  process.exit(4);
});
