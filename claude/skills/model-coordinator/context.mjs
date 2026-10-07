// The context builder: turns the worker table, recent exchanges and the user's line into one CoordinatorInput that
// fits the token budget. Pure apart from reading instructions.md once.
import { readFileSync } from "node:fs";
import { toSummary } from "./workers.mjs";
import { FINISHED } from "./validate.mjs";

const DAY_MS = 24 * 3600 * 1000;
const MAX_FINISHED = 12;
const CAPS = { user: 500, reply: 300, message: 2000, instruction: 600, project: 200 };

/** Math.ceil(JSON.stringify(obj).length / 4). */
export const estimateTokens = (obj) => Math.ceil(JSON.stringify(obj).length / 4);

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

const when = (w) => {
  const v = w.finished_at ?? w.ended_at ?? w.updated_at ?? w.created_at;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Workers Luna sees: every live worker, plus up to 12 finished in the last 24 h (newest first). */
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
  const allEx = (Array.isArray(exchanges) ? exchanges : []).slice(-Math.max(1, ctx.exchanges ?? 5));
  const st = { nEx: allEx.length, workerLevel: 0, lastResult: null, finished: true, instr: CAPS.instruction };

  const view = () => {
    const ws = [...liveW, ...(st.finished ? done : [])].map((w) => {
      const s = summarize(w, st.workerLevel);
      return st.lastResult === null ? s : { ...s, last_result: clip(s.last_result, st.lastResult) };
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

  // Cuts, in order, until the input fits. The first four are the plan's; the last two (compact workers, shorter
  // instruction) exist because 12 full-size live workers alone exceed 3000 tokens, so the plan's list cannot always fit.
  const cuts = [
    () => { st.nEx = Math.min(st.nEx, 4); },
    () => { st.lastResult = 100; },
    () => { st.finished = false; },
    () => { st.nEx = Math.min(st.nEx, 2); },
    () => { st.workerLevel = 1; },
    () => { st.workerLevel = 2; st.instr = 300; },
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
