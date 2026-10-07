// The context builder: turns the worker table, recent exchanges and the user's line into one CoordinatorInput that
// fits the token budget. Pure apart from reading instructions.md once.
import { readFileSync } from "node:fs";
import { toSummary } from "./workers.mjs";
import { FINISHED } from "./validate.mjs";

const DAY_MS = 24 * 3600 * 1000;
const MAX_FINISHED = 12;
const CAPS = { user: 500, reply: 300, message: 2000, instruction: 600, project: 200 };

/** One token per non-ASCII character (Hebrew, emoji, ...) plus ASCII characters / 4, over the JSON text. */
export function estimateTokens(obj) {
  const json = JSON.stringify(obj) ?? "";
  let ascii = 0, other = 0;
  for (const ch of json) { if (ch.codePointAt(0) < 128) ascii++; else other++; }
  return other + Math.ceil(ascii / 4);
}

let cachedInstructions = null;
export function instructionsText() {
  cachedInstructions ??= readFileSync(new URL("./instructions.md", import.meta.url), "utf8").trim();
  return cachedInstructions;
}

/** Cuts to n characters (never in the middle of a surrogate pair) and appends `[... N chars cut]`. */
export function cutText(s, n) {
  const t = typeof s === "string" ? s : s == null ? "" : String(s);
  if (t.length <= n) return t;
  let end = n;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${t.slice(0, end)}[... ${t.length - end} chars cut]`;
}
const clip = (s, n) => { // plain cut, no marker (for summary fields that are already short)
  const t = typeof s === "string" ? s : "";
  if (t.length <= n) return t;
  const c = t.charCodeAt(n - 1);
  return t.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
};

function capDeep(v, n, depth = 0) {
  if (typeof v === "string") return clip(v, n);
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => capDeep(x, n, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 16).map(([k, x]) => [k, capDeep(x, n, depth + 1)]));
  return v;
}

/** When a finished worker finished (epoch ms), or null when unknown. The fold stamps finished_at from the event time. */
const when = (w) => {
  const v = w.finished_at;
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Workers Luna sees: every live worker, plus up to 12 finished in the last 24 h (newest first; an unknown time is kept). */
function pickWorkers(workers, now) {
  const all = workers instanceof Map ? [...workers.values()] : Array.isArray(workers) ? workers : [];
  const liveW = all.filter((w) => !FINISHED.has(w.status));
  const done = all.filter((w) => FINISHED.has(w.status) && ((t) => t === null || now - t <= DAY_MS)(when(w)))
    .sort((a, b) => (when(b) ?? 0) - (when(a) ?? 0)).slice(0, MAX_FINISHED);
  return { liveW, done };
}

/** A WorkerSummary at the given field caps (the first level is toSummary's own caps). */
function summarize(w, level) {
  const s = toSummary(w);
  if (level === 0) return s;
  if (level === 3) return { id: s.id, label: s.label, status: s.status };
  const L = level === 1 ? { o: 100, t: 100, r: 100 } : { o: 60, t: 60, r: 60 };
  return {
    ...s, aliases: s.aliases.slice(0, 3), objective: clip(s.objective, L.o), current_task: clip(s.current_task, L.t),
    last_result: clip(s.last_result, L.r), blockers: s.blockers.slice(0, 1).map((b) => clip(b, L.t)),
  };
}

/**
 * @param {{cfg?: object, project?: object, workers: Map|object[], focusedId?: string|null, referents: object,
 *   exchanges?: object[], message: string, validationErrors?: object[], now?: number}} p exchanges run oldest first
 * @returns {object} CoordinatorInput: {v, instructions, project, workers, focused_session_id, referents, exchanges, message, validation_errors?}
 */
export function buildInput({ cfg = {}, project = {}, workers = [], focusedId = null, referents = {}, exchanges = [], message = "", validationErrors, now = Date.now() } = {}) {
  const ctx = cfg.context ?? {};
  const max = ctx.max_tokens ?? 3000;
  const { liveW, done } = pickWorkers(workers, now);
  const nCfg = Number.isInteger(ctx.exchanges) && ctx.exchanges >= 0 ? ctx.exchanges : 5;
  const exList = Array.isArray(exchanges) ? exchanges : [];
  const allEx = nCfg === 0 ? [] : exList.slice(-nCfg);
  const st = { nEx: allEx.length, workerLevel: 0, lastResult: null, finished: true, instr: CAPS.instruction };

  const view = () => {
    const ws = [...liveW, ...(st.finished ? done : [])].map((w) => {
      const s = summarize(w, st.workerLevel);
      return st.lastResult === null || st.workerLevel >= 3 ? s : { ...s, last_result: clip(s.last_result, st.lastResult) };
    });
    const ex = allEx.slice(allEx.length - st.nEx).map((e) => ({
      user: clip(e?.user, CAPS.user), reply: clip(e?.reply, CAPS.reply), action: e?.action ?? null,
      targets: Array.isArray(e?.targets) ? e.targets.slice(0, 8) : [],
    }));
    const input = {
      v: 1, instructions: instructionsText(), project: capDeep({ repo: project.repo ?? null, codex: project.codex ?? null, cost: project.cost ?? null }, CAPS.project),
      workers: ws, focused_session_id: focusedId ?? null,
      referents: { ...referents, last_instruction: referents.last_instruction == null ? null : cutText(referents.last_instruction, st.instr) },
      exchanges: ex, message: cutText(message, CAPS.message),
    };
    if (Array.isArray(validationErrors) && validationErrors.length) input.validation_errors = capDeep(validationErrors.slice(0, 10), 120);
    return input;
  };

  // Cuts, in order, until the input fits. The first four are the plan's. The last three exist because full-size live
  // workers alone can exceed the budget: compact summaries, then shorter fields and instruction, then (live workers are
  // never dropped) only id, label and status per worker.
  const cuts = [
    () => { st.nEx = Math.min(st.nEx, 4); },
    () => { st.lastResult = 100; },
    () => { st.finished = false; },
    () => { st.nEx = Math.min(st.nEx, 2); },
    () => { st.workerLevel = 1; },
    () => { st.workerLevel = 2; st.instr = 300; },
    () => { st.workerLevel = 3; },
  ];
  let input = view();
  for (const cut of cuts) {
    if (estimateTokens(input) <= max) break;
    cut();
    input = view();
  }
  if (estimateTokens(input) > max) throw new Error("context-over-budget");
  return input;
}
