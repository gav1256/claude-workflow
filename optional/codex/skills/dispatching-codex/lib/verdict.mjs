// `codex-run --verdict <run-id|sonnet:task> approve|rework|reject "<note>"`: the controller's ruling, appended to
// the run ledger. A codex run id must already have a run line there. Returns the object codex-run prints.
import fs from "node:fs";
import path from "node:path";
import { LEDGER } from "./paths.mjs";

const VERDICTS = ["approve", "rework", "reject"];
const NOTE_MAX = 200;
const blocked = (reason) => ({ ok: false, status: "blocked", reason });

function hasRunLine(runId) {
  let text;
  try { text = fs.readFileSync(LEDGER, "utf8"); } catch { return false; }
  for (const line of text.split("\n")) {
    if (!line.includes(runId)) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.run_id === runId && "status" in o) return true;
    } catch { /* skip a torn line */ }
  }
  return false;
}

export function verdictCmd(argv) {
  const i = Array.isArray(argv) ? argv.indexOf("--verdict") : -1;
  if (i < 0) return blocked("bad-args");
  const [target, word, ...rest] = argv.slice(i + 1);
  if (!target || word === undefined) return blocked("bad-args");
  if (!VERDICTS.includes(word)) return blocked("bad-verdict");
  const note = rest.join(" ").trim().slice(0, NOTE_MAX);
  const ts = new Date().toISOString();
  let line;
  if (target.startsWith("sonnet:")) {
    const task = target.slice(7).trim();
    if (!task) return blocked("bad-args");
    line = { ts, run_id: null, task, writer: "sonnet", verdict: word, note };
  } else {
    if (!hasRunLine(target)) return blocked("unknown-run");
    line = { ts, run_id: target, verdict: word, note };
  }
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(line) + "\n");
  } catch (e) {
    return blocked(`ledger-write: ${String(e?.message ?? e).slice(0, 100)}`);
  }
  return { ok: true, ...line };
}
