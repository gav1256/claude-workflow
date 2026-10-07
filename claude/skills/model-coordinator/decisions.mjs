// The Decisions routing core: a request builder and an answer interpreter. PURE: no I/O, no clock, no randomness.
//
// buildDecisionsRequest turns the worker table and the user's message into the Decisions API input string plus its questions;
// interpretAnswers turns the answers into a RoutePlan (a CoordinatorDecision built by code), a clarify text, an advice text or
// "unusable". A route comes only from code: nothing the model returns is executed, and an answer that is not one of the offered
// values is unusable. The message is never cut: routing must see everything that will be dispatched.
import { toSummary } from "./workers.mjs";
import { FINISHED, MESSAGEABLE, validateDecision } from "./validate.mjs";
import { LABEL_RE, LIMITS, emptyDecision } from "./schema.mjs";
import { pronounOf } from "./resolve.mjs";

export const RISKY_RE = /\b(delete|drop|reset|wipe|erase|purge|destroy|force[- ]push|rm\s+-rf|revert all|truncate)\b/i;
export const TEXT_RE = /\b(plan|explain|design|investigate|research|compare|propose|figure out|evaluate)\b/i;
export const EPS = 1e-9;

const FIXED = ["new_session", "status", "respond", "clarify"];
const MAX_CONCERNS = 8;
const CTRL_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const list = (w) => (w instanceof Map ? [...w.values()] : Array.isArray(w) ? w : []);
const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const clean = (v) => str(v).replace(CTRL_G, " ");
const cap = (v, n) => clean(v).slice(0, n);
const ge = (a, b) => a >= b - EPS;
const isLive = (w) => MESSAGEABLE.has(w.status);
const isFinite01 = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const safeSlice = (s, n) => { const t = s.slice(0, n); return t.length === n && /[\ud800-\udbff]$/.test(t) ? t.slice(0, -1) : t; };

const timeOf = (w) => {
  const c = w.created_at;
  const t = typeof c === "number" ? c : typeof c === "string" ? Date.parse(c) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/** At most 8 live workers, the focused one first, then `recent` order, then the rest by created_at descending. */
function concernSet(live, focusedId, recent) {
  const byId = new Map(live.map((w) => [w.id, w]));
  const out = [];
  const add = (id) => { if (byId.has(id) && !out.includes(id)) out.push(id); };
  add(focusedId);
  for (const id of Array.isArray(recent) ? recent : []) add(id);
  const rest = live.map((w, i) => ({ w, i })).filter(({ w }) => !out.includes(w.id))
    .sort((a, b) => (timeOf(a.w) === timeOf(b.w) ? 0 : timeOf(b.w) > timeOf(a.w) ? 1 : -1) || b.i - a.i);
  for (const { w } of rest) out.push(w.id);
  return out.slice(0, MAX_CONCERNS);
}

/** Question names for the concern predicates: `concerns_<id>` with the id reduced to [a-z0-9_], unique. */
function concernNames(ids) {
  const map = {};
  for (const id of ids) {
    const base = `concerns_${id.toLowerCase().replace(/[^a-z0-9_]/g, "_")}`;
    let name = base, n = 1;
    while (Object.hasOwn(map, name)) name = `${base}_${++n}`;
    map[name] = id;
  }
  return map;
}

const wline = (w, full) => {
  if (!full) return `- ${clean(w.id)} [${clean(w.status)}] label=${clean(w.label)}`;
  const s = toSummary(w);
  return `- ${clean(s.id)} [${clean(s.provider)}, ${clean(s.status)}] label=${clean(s.label)} aliases=${s.aliases.map(clean).join("|")}`
    + ` objective=${cap(s.objective, 200)} task=${cap(s.current_task, 200)} last=${cap(s.last_result, 150)}`;
};

/**
 * @returns {{input: string, questions: object[], offered: {route: string[], provider: string[], concerns: object}} | {tooLong: true}}
 * `tooLong` when the message exceeds cfg.decisions.max_message_chars, or the input cannot be made to fit max_input_chars even
 * after every other section has shrunk (the message itself is never cut).
 */
export function buildDecisionsRequest({ workers, focusedId = null, referents = null, exchanges = [], lastEvent = null, message, codexEligible = false, cfg }) {
  const c = cfg.decisions, msg = str(message);
  if (msg.length > c.max_message_chars) return { tooLong: true };
  const live = list(workers).filter(isLive);
  const refs = referents ?? {};
  const ids = (a) => (Array.isArray(a) && a.length ? a.map(clean).join(",") : "none");
  const one = (v) => (v ? clean(v) : "none");
  const ex = (Array.isArray(exchanges) ? exchanges : []).slice(-6);
  const event = lastEvent ? cap(lastEvent, 150) : null;

  const render = ({ turns, full, withEvent }) => {
    const lines = [
      `Message: ${clean(msg)}`,
      `Focused worker: ${one(focusedId)}`,
      `Referents: singular=${one(refs.singular)} other=${one(refs.other)} both=${ids(refs.both)} recent=${ids(refs.recent)}`,
      "Recent turns (oldest first):",
      ...ex.slice(ex.length - Math.min(turns, ex.length)).map((e) => `- user: ${cap(e?.user, 200)} | reply: ${cap(e?.reply, 200)} | action: ${one(e?.action)} -> ${ids(e?.targets)}`),
      `Last event: ${withEvent && event ? event : "none"}`,
      "Workers:",
      ...live.map((w) => wline(w, full)),
    ];
    return lines.join("\n");
  };
  const levels = [
    { turns: 6, full: true, withEvent: true }, { turns: 2, full: true, withEvent: true }, { turns: 0, full: true, withEvent: true },
    { turns: 0, full: false, withEvent: true }, { turns: 0, full: false, withEvent: false },
  ];
  let input = null;
  for (const lv of levels) {
    const s = render(lv);
    if (s.length <= c.max_input_chars) { input = s; break; }
  }
  if (input === null) return { tooLong: true };

  const route = live.map((w) => {
    const s = toSummary(w);
    const description = `${clean(s.provider)}, ${clean(s.status)}; ${clean(s.label)}; aliases ${s.aliases.map(clean).join(", ")}; goal ${clean(s.objective)}; now ${clean(s.current_task)}; last ${clean(s.last_result)}`;
    return { value: w.id, description: description.slice(0, 300) };
  });
  route.push(
    { value: "new_session", description: "Start a new worker" },
    { value: "status", description: "The user asks how the workers are doing" },
    { value: "respond", description: "The coordinator answers, explains or summarises itself; nothing is sent to a worker" },
    { value: "clarify", description: "It is not possible to tell where the message should go" },
  );
  const providerChoices = [{ value: "claude", description: "Claude Code worker (default)" }];
  if (codexEligible) providerChoices.push({ value: "codex", description: "Codex worker" });
  const byId = new Map(live.map((w) => [w.id, w]));
  const concerns = concernNames(concernSet(live, focusedId, refs.recent));
  const questions = [
    { type: "choice", name: "route", choices: route,
      instructions: "Pick where the user's message should go. A worker id means the message is for that worker. new_session: the user wants a new worker started. status: the user asks how workers are doing. respond: the user wants an answer, explanation, summary or discussion from the coordinator itself. clarify: you cannot tell." },
    { type: "choice", name: "provider", choices: providerChoices,
      instructions: "If a new worker is started, which kind fits: claude (default, any coding work) or codex (only when the user asks for Codex or the task suits it)" },
    ...Object.entries(concerns).map(([name, id]) => ({ type: "predicate", name,
      instructions: `The user's message is meant for worker ${clean(id)} (${clean(byId.get(id).label)}).` })),
    { type: "predicate", name: "needs_text",
      instructions: "Starting the new worker needs a written brief because the goal is vague, long, or asks for a plan or explanation." },
  ];
  return { input, questions, offered: { route: route.map((r) => r.value), provider: providerChoices.map((p) => p.value), concerns } };
}

// ---- labels ---------------------------------------------------------------------------------------------------

const STOP = new Set(["a", "an", "the", "to", "for", "and", "of", "make", "new", "worker", "please", "start", "create"]);

/** Ids, labels and aliases of every non-finished worker (what validate.mjs checks a new label against). */
export function takenNames(workers) {
  const out = new Set();
  for (const w of list(workers)) {
    if (FINISHED.has(w.status)) continue;
    out.add(w.id); out.add(w.label);
    for (const a of w.aliases ?? []) out.add(a);
  }
  return out;
}

/** A label that passes LABEL_RE and is not in `taken`: a slug of the first three meaningful words, suffixed `-n` on a clash. */
export function labelFrom(message, taken) {
  const words = (str(message).toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((x) => !STOP.has(x)).slice(0, 3);
  let base = words.join("-").slice(0, 32).replace(/-+$/, "");
  if (!base || !LABEL_RE.test(base)) base = "worker";
  const used = taken instanceof Set ? taken : new Set(taken ?? []);
  for (let n = 1; n < used.size + 3; n++) {
    const cand = n === 1 ? base : `${base.slice(0, 32 - `-${n}`.length).replace(/-+$/, "")}-${n}`;
    if (LABEL_RE.test(cand) && !used.has(cand)) return cand;
  }
  return `worker-${used.size + 2}`;
}

// ---- interpretation -------------------------------------------------------------------------------------------

const isChoice = (a) => !!a && a.type === "choice" && typeof a.choice === "string" && a.probs instanceof Map;
const isPredicate = (a) => !!a && a.type === "predicate" && isFinite01(a.pTrue);

/** p1 = the chosen value's probability; p2 = the larger of the best other reported value and the unreported mass. */
function top2(answer) {
  const p1 = answer.probs.get(answer.choice);
  let other = 0, sum = 0;
  for (const [v, p] of answer.probs) { sum += p; if (v !== answer.choice && p > other) other = p; }
  return { p1, p2: Math.max(other, 1 - sum) };
}

const adviceText = (id, status) => (status === "finished" ? `${id} is finished. Start a new one with /new claude|codex <label> <objective>.`
  : `${id} is dead. Use /restart-closed to reopen closed sessions, or start a new one with /new.`);

/**
 * `byName` is Answers.byName (decisions-provider.mjs); `offered` comes from the request; `workers` is the FRESH view read after
 * the call. @returns {{kind: "plan", decision, writer: null|"reply"|"brief", meta} | {kind: "clarify"|"advice", text, meta} | {kind: "unusable", reason}}
 */
export function interpretAnswers(byName, { offered, workers, focusedId = null, referents = null, message, cfg }) {
  const c = cfg.decisions, msg = str(message), refs = referents ?? {};
  const ws = list(workers), byId = new Map(ws.map((w) => [w.id, w]));
  const answers = byName && typeof byName === "object" ? byName : {};
  const meta = { p1: null, margin: null, winner: null };
  const clarify = (text) => ({ kind: "clarify", text, meta });

  const nameOf = (id) => (byId.has(id) ? `${clean(id)} (${clean(byId.get(id).label)})` : clean(id));
  const isWorkerId = (v) => offered.route.includes(v) && !FIXED.includes(v);
  const phrase = (v) => (v === "new_session" ? "start a new worker" : v === "status" ? "a status update" : v === "respond" ? "an answer from me" : `send it to ${nameOf(v)}`);
  const noCandidates = () => {
    const items = ws.filter((w) => !FINISHED.has(w.status)).map((w) => `${clean(w.id)} (${clean(w.status)})`);
    const build = (xs) => `I could not tell where that should go. Workers: ${xs.length ? xs.join(", ") : "none"}. Use /to <id> <text> or /new.`;
    while (items.length > 1 && build(items).length >= LIMITS.clarification) items.pop();
    return build(items);
  };
  let ranked = [];
  const clarifyAmong = (primary) => {
    const base = primary.filter(Boolean);
    const seen = new Set();
    const list2 = [...(base.length >= 2 ? base : [...base, meta.winner, ...ranked])]
      .filter((v) => typeof v === "string" && v !== "clarify" && offered.route.includes(v) && !seen.has(v) && seen.add(v));
    const cands = list2.slice(0, base.length >= 2 ? 3 : 2);
    if (cands.length < 2) return clarify(noCandidates());
    if (cands.every(isWorkerId)) {
      const names = cands.map(nameOf);
      return clarify(`Which worker do you mean: ${names.length === 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`}? Use /to <id> <text> to be exact.`);
    }
    return clarify(`Did you mean ${phrase(cands[0])} or ${phrase(cands[1])}? Use /to <id> <text>, /new claude|codex <label> <objective>, or /status to be exact.`);
  };

  // 1. any refusal, before any shape check
  if (Object.values(answers).some((a) => a && a.type === "refusal")) return clarify(noCandidates());

  // 0. shape: every offered question has a usable answer, and a choice is one of the offered values
  const bad = (reason) => ({ kind: "unusable", reason });
  const route = answers.route, provider = answers.provider, needs = answers.needs_text;
  const choiceOk = (a, values) => isChoice(a) && values.includes(a.choice) && isFinite01(a.probs.get(a.choice)) && [...a.probs.values()].every(isFinite01);
  if (!choiceOk(route, offered.route)) return bad("route answer missing or not an offered value");
  if (!choiceOk(provider, offered.provider)) return bad("provider answer missing or not an offered value");
  if (!isPredicate(needs)) return bad("needs_text answer missing");
  const concernIds = Object.values(offered.concerns);
  const pTrue = (id) => answers[Object.keys(offered.concerns).find((k) => offered.concerns[k] === id)].pTrue;
  for (const [name, id] of Object.entries(offered.concerns)) if (!isPredicate(answers[name])) return bad(`${name} answer missing for ${id}`);

  const winner = route.choice, isWorker = isWorkerId(winner), pron = pronounOf(msg);
  const { p1, p2 } = top2(route), margin = p1 - p2;
  Object.assign(meta, { p1, margin, winner });
  ranked = [...route.probs].filter(([v]) => v !== winner).sort((a, b) => b[1] - a[1]).map(([v]) => v);
  const H = concernIds.filter((id) => ge(pTrue(id), c.concern_high));
  const U = concernIds.filter((id) => pTrue(id) > c.concern_low && !ge(pTrue(id), c.concern_high));
  const RISKY = RISKY_RE.test(msg);
  const riskyText = "That looks destructive. Which worker, exactly? Use /to <id> <text>.";

  // 2. referent contradictions, before any message route
  if (pron === "other" && (winner === focusedId || (!focusedId && winner === refs.singular))) return clarifyAmong([winner, refs.other]);
  if (pron === "other" && focusedId && H.includes(focusedId)) return clarifyAmong([focusedId, ...H.filter((id) => id !== focusedId)]);
  if ((pron === "singular" || pron === "other") && H.length >= 2) return clarifyAmong(H);

  // the advice for a worker that cannot take a message in the fresh view, or null
  const adviceFor = (id) => {
    const w = byId.get(id);
    if (!w) return { kind: "advice", text: `${id} is no longer listed. Use /workers to see the current workers.`, meta };
    if (!MESSAGEABLE.has(w.status)) return { kind: "advice", text: adviceText(id, w.status), meta };
    return null;
  };
  const finish = (decision, writer = null) => {
    const check = decision.worker_instruction && decision.worker_instruction.length > LIMITS.worker_instruction
      ? { ...decision, worker_instruction: decision.worker_instruction.slice(0, LIMITS.worker_instruction) } : decision;
    const v = validateDecision(check, { workers: ws });
    if (!v.ok) return bad(`invalid plan: ${v.errors.map((e) => `${e.code}@${e.field}`).join(", ")}`);
    return { kind: "plan", decision, writer, meta };
  };
  const send = (action, targets) => finish(emptyDecision({ action, reply: `Sending to ${targets.join(", ")}.`, target_session_ids: targets, worker_instruction: msg }));

  // 3. concerns
  if (U.length && (isWorker || winner === "status")) return clarifyAmong([...U, ...H]);
  if (H.length >= 2) {
    if (RISKY && H.some((id) => !ge(pTrue(id), c.risky_min_probability))) return clarify(riskyText);
    if (H.includes(winner)) {
      for (const id of H) { const a = adviceFor(id); if (a) return a; }
      return send("message_multiple", H);
    }
    if (winner === "status") return finish(emptyDecision({ action: "request_status", target_session_ids: H.filter((id) => byId.has(id)) }));
    return clarifyAmong(H);
  }

  // 4. route probability and margin
  if (!ge(p1, c.min_route_probability) || !ge(margin, c.min_margin)) return clarifyAmong([winner, ...ranked]);

  // 5. a worker winner
  if (isWorker) {
    if (!concernIds.includes(winner)) return clarifyAmong([winner, H[0]]);
    if (H.length === 1 && !H.includes(winner)) return clarifyAmong([winner, H[0]]);
    if (!ge(pTrue(winner), c.concern_high)) return clarifyAmong([winner]);
    const a = adviceFor(winner);
    if (a) return a;
  }

  // 6. destructive wording without a confident route
  if (RISKY && !ge(p1, c.risky_min_probability)) return clarify(riskyText);

  // 7. the winner
  if (isWorker) return send("message_session", [winner]);
  switch (winner) {
    case "new_session": {
      const pp = top2(provider);
      if (!ge(pp.p1, c.min_route_probability) || !ge(pp.p1 - pp.p2, c.min_margin)) return clarify("Should the new worker be Claude or Codex? Use /new claude|codex <label> <objective>.");
      const brief = msg.length > 400 || TEXT_RE.test(msg) || ge(needs.pTrue, c.needs_text_threshold);
      const objective = safeSlice(msg, LIMITS.objective);
      return finish(emptyDecision({ action: "create_session", reply: "", new_session: { needed: true, provider: provider.choice, label: labelFrom(msg, takenNames(ws)), objective } }), brief ? "brief" : null);
    }
    case "status": return finish(emptyDecision({ action: "request_status", target_session_ids: H.filter((id) => byId.has(id)) }));
    case "respond": return finish(emptyDecision({ action: "respond", reply: "" }), "reply");
    default: return clarifyAmong([]);
  }
}
