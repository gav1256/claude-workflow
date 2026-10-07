// A stand-in for codex-run.mjs. It starts no Codex and makes no network call.
//   node fake-codex-run.mjs --brief <file> --cwd <dir> --mode write [--model m] [--effort e] [--task t] [--continue <run>]
// FAKE_RUN_SCENARIO names a JSON file: {status, reason, delay_ms, files: {path: text}, die_without_line, run_id,
// codex_note, run_null, tasks: {"<task>": {...same keys...}}}. A key under `tasks` for this run's --task overrides the top level.
// FAKE_ENV_DUMP names a file that receives the NAMES of the env this process got, one per line.
// It writes the files into --cwd (not for a blocked run), sleeps delay_ms, appends {ts, run_id, task, mode, status} to
// <CLAUDE_CONFIG_DIR>/state/codex/runs.jsonl and prints one JSON line (nothing at all when die_without_line is set).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.FAKE_ENV_DUMP) fs.writeFileSync(process.env.FAKE_ENV_DUMP, Object.keys(process.env).join("\n"));

const argv = process.argv.slice(2), a = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;

let sc = {};
try {
  const all = JSON.parse(fs.readFileSync(process.env.FAKE_RUN_SCENARIO, "utf8"));
  const { tasks = {}, ...top } = all;
  sc = { ...top, ...(tasks[a.task] ?? {}) };
} catch { /* no scenario: a quick done run */ }

const status = sc.status ?? "done";
const runId = sc.run_id ?? `fake-${String(a.task ?? "x").replace(/[^A-Za-z0-9._-]/g, "_")}-${Math.random().toString(36).slice(2, 8)}`;
const t0 = Date.now();
const files = Object.keys(sc.files ?? {});

if (status !== "blocked") {
  if (!a.cwd || !fs.existsSync(a.cwd)) { fin("blocked", "cwd-missing"); }
  else for (const [p, text] of Object.entries(sc.files ?? {})) {
    const f = path.join(a.cwd, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
}
if (sc.delay_ms) await new Promise((r) => setTimeout(r, sc.delay_ms));
fin(status, sc.reason ?? null);

function fin(st, reason) {
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const ledger = path.join(cfg, "state", "codex", "runs.jsonl");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.appendFileSync(ledger, JSON.stringify({ ts: Date.now(), run_id: runId, task: a.task ?? null, mode: a.mode ?? null, status: st }) + "\n");
  if (!sc.die_without_line) {
    process.stdout.write(JSON.stringify({
      run: sc.run_null ? null : runId, status: st, reason, mode: a.mode ?? null, model: a.model ?? null, model_downgraded: false,
      secs: Math.round((Date.now() - t0) / 1000), files: st === "blocked" ? [] : files, checks: sc.checks ?? [], host_checks: [],
      codex_note: sc.codex_note ?? (st === "done" ? "fake run done" : null), week_pct: 10, orphans: [],
    }) + "\n");
  }
  process.exit(0);
}
