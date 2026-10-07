// A fake `codex` for tests, injected through CODEX_RUN_BIN (+ CODEX_RUN_BIN_ARGS).
// Behaviour comes from the JSON file named by FAKE_CODEX_SCENARIO (default: {}).
//
//   --version                 prints "codex-cli <scenario.version|0.160.0>"
//   features list             prints scenario.features (array of lines)
//   sandbox ... -- cmd /d /c <file>
//       file has `echo R:<n>` lines (read check): prints D:<n> per target (R:<n> for indexes in
//         scenario.readOpen), then END (scenario.readGarbage drops END); one `C:ok` line (the positive
//         control) comes first unless scenario.noControl
//       file contains `codex-gate-` (a gate probe write): exit 1 and no file; scenario.gateOpen = the write lands
//         (the file is created, exit 0); scenario.gateDenied = "Access is denied." on stderr, exit 0, no file
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
//       scenario.grandchild: true|"attached" = non-detached (dies with the fake: libuv's kill-on-close job);
//         "detached" = detached, hidden, unref'd (survives the fake, as sandboxed grandchildren survive
//         codex.exe). scenario.grandchildTag (string) is appended to the grandchild's argv so a fixture can
//         match it by command line; scenario.grandchildMs (default 120000) is how long it lives.
//       scenario.links [{kind: "junction"|"hardlink", path, target}]: after the writes, a junction (cmd /c mklink /J)
//         or a hard link at `path` (relative to -C) pointing at the absolute `target`;
//       scenario.fileSymlinks [{path, target}]: after the writes, a file symlink at `path` (relative to -C) to the absolute `target`;
//       scenario.tmpJunction (absolute dir): after the writes, -C\.codex-tmp is replaced by a junction to it.
//   Recording knobs for tests: scenario.sandboxTextFile (every `sandbox` call appends the check file's text, JSON-quoted),
//   scenario.execRounds (overrides per exec, last repeated) + execCountFile (counter); helpers do not advance it.
//   scenario.argvFile (JSON array of the argv), scenario.stdinFile (the stdin text), scenario.pidFile ({pid, grandchild}), scenario.envFile (exec: JSON array of the environment
//   variable NAMES the fake was started with), scenario.sandboxEnvFile (every `sandbox` call appends one JSON line of
//   the environment variable names).
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

function mklinkJunction(link, target) {
  const cmdExe = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  const r = spawnSync(cmdExe, ["/d", "/s", "/c", `"mklink /J "${link}" "${target}""`], {
    windowsHide: true, windowsVerbatimArguments: true, encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`mklink /J failed: ${r.stdout}${r.stderr}`);
}

async function sandbox() {
  if (sc.sandboxEnvFile) fs.appendFileSync(sc.sandboxEnvFile, JSON.stringify(Object.keys(process.env)) + "\n");
  const dd = argv.indexOf("--");
  const file = dd >= 0 ? argv[argv.length - 1] : undefined;
  if (!file) {
    await write(process.stderr, "fake-codex: sandbox needs `-- cmd.exe /d /c <file>`\n");
    return 2;
  }
  const text = fs.readFileSync(file, "utf8");
  if (sc.sandboxTextFile) fs.appendFileSync(sc.sandboxTextFile, JSON.stringify(text) + "\n");
  const targets = [...text.matchAll(/echo R:(\d+)/g)].map((m) => Number(m[1]));
  if (targets.length) {
    const open = new Set(sc.readOpen ?? []);
    let out = sc.noControl ? "" : "C:ok\n"; // the positive control readcheck.mjs requires
    for (const n of targets) out += `${open.has(n) ? "R" : "D"}:${n}\n`;
    if (!sc.readGarbage) out += "END\n";
    await write(process.stdout, out);
    return 0;
  }
  if (text.includes("codex-gate-")) {
    if (sc.gateOpen) { // an open sandbox: the probe write lands (the target is the quoted path after `echo x>`)
      const m = /echo x> "([^"]*)"/.exec(text);
      if (m) fs.writeFileSync(m[1].replace(/%%/g, "%"), "x\r\n");
      return 0;
    }
    if (sc.gateDenied) { // what a failed redirect in a .cmd does: a message, ERRORLEVEL still 0, no file
      await write(process.stderr, "Access is denied.\n");
      return 0;
    }
    return 1;
  }
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
  if (sc.execRounds) {
    let n = 0;
    try { n = Number(fs.readFileSync(sc.execCountFile, "utf8")); } catch { /* first exec */ }
    fs.writeFileSync(sc.execCountFile, String(n + 1));
    sc = { ...sc, ...sc.execRounds[Math.min(n, sc.execRounds.length - 1)] };
  }
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

  for (const l of sc.links ?? []) {
    const link = path.resolve(cdir, l.path);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (l.kind === "hardlink") fs.linkSync(l.target, link);
    else mklinkJunction(link, l.target);
  }
  for (const l of sc.fileSymlinks ?? []) { // a file symlink at `path` (relative to -C) pointing at the absolute `target`
    const link = path.resolve(cdir, l.path);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(l.target, link, "file");
  }
  if (sc.tmpJunction) {
    const tmp = path.join(cdir, ".codex-tmp");
    fs.rmSync(tmp, { recursive: true, force: true });
    mklinkJunction(tmp, sc.tmpJunction);
  }
  if (sc.envFile) fs.writeFileSync(sc.envFile, JSON.stringify(Object.keys(process.env)));

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
    const ms = Number.isFinite(sc.grandchildMs) ? sc.grandchildMs : 120000;
    const tag = typeof sc.grandchildTag === "string" ? [sc.grandchildTag] : [];
    const gc = spawn(process.execPath, ["-e", `setTimeout(()=>{},${ms})`, ...tag], {
      detached: sc.grandchild === "detached", stdio: "ignore", windowsHide: true,
    });
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
