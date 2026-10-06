// Run ledger: one JSON line per run in STATE/runs.jsonl (spec Part 2 step 6).
import fs from "node:fs";
import path from "node:path";
import { LEDGER } from "./paths.mjs";

export const LEDGER_KEYS = ["ts", "run_id", "task", "mode", "model", "writer", "effort", "status",
  "checks_passed", "host_checks", "secs", "codex_tokens", "files", "week_pct"];

/** Append one line with exactly LEDGER_KEYS (missing values are null). */
export function appendRun(o) {
  const line = {};
  for (const k of LEDGER_KEYS) line[k] = o[k] === undefined ? null : o[k];
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(line) + "\n");
}
