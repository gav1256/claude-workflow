// The turn loop: one user line in, one reply out. resolveLine (no model) decides shortcuts; anything else goes to the Decisions
// provider first (code routes from its probabilities: decisions.mjs), and falls back to the provider (Luna) as one strict decision
// per call when Decisions is down or unusable; the decision is validated, re-asked once on errors, and dispatched by the dispatcher.
// Lines are handled strictly one at a time (a promise chain): two overlapping lines can never both pass the spend check against
// the same spend. Imports only provider.mjs for the provider contract (ProviderError); it never touches a file except through the
// store it is given (the exchanges ledger).
import { resolveLine } from "./resolve.mjs";
import { buildInput } from "./context.mjs";
import { validateDecision, lowConfidence, FINISHED } from "./validate.mjs";
import { focusOf } from "./workers.mjs";
import { ProviderError } from "./provider.mjs";
import { buildDecisionsRequest, interpretAnswers, cleanLine } from "./decisions.mjs";
import { emptyDecision } from "./schema.mjs";
import { clean } from "./records.mjs";

const cap = (s, n) => String(s ?? "").slice(0, n);
const money = (v) => `$${Number(v).toFixed(2).replace(/\.00$/, "")}`;
const SHORTCUTS = "Use /to <id> <text>, /status, /new claude|codex <label> <objective>.";
const round3 = (v) => Math.round(Number(v) * 1000) / 1000;
/** Codex is offered to Decisions only when the login works AND quota and capacity are known to be fine (codex-resources.mjs resourceState). */
const codexEligible = (cs) => cs?.available === true && cs.usage_status === "ok" && cs.capacity_available === true;

/**
 * validateDecision with one exception: a `verbatim` decision (a /to shortcut) may carry a worker_instruction longer than the
 * model limit, because the delivery path owns long texts. Only "too-long" on worker_instruction is ignored; every other check
 * (targets, control characters, label, ...) still applies, to the full text and to a capped copy (a shape error hides the
 * semantic ones, so the capped copy is checked as well).
 */
/** The spend line's ending for each cost state (shared with the CLI's --status line). */
export const STATE_WORD = { ok: "ok.", soft: "soft limit reached.", hard: "hard limit reached: model calls paused." };

export function validateForDispatch(d, { workers, verbatim = false }) {
  const full = validateDecision(d, { workers });
  if (!verbatim || full.ok) return full;
  const errors = full.errors.filter((e) => !(e.code === "too-long" && e.field === "worker_instruction"));
  if (errors.length < full.errors.length) {
    const capped = validateDecision({ ...d, worker_instruction: String(d.worker_instruction ?? "").slice(0, 4000) }, { workers });
    for (const e of capped.errors) if (!errors.some((x) => x.code === e.code && x.field === e.field)) errors.push(e);
  }
  return { ok: errors.length === 0, errors };
}

const HELP = [
  "/to <worker>[,<worker>...] <text>   send text to one or more workers, verbatim",
  "/status [<worker>...]               show workers (no model call)",
  "/new claude|codex <label> [--in <worker>] <objective>   start a worker",
  "/alias <worker> <alias>             give a worker another name",
  "/workers   list workers    /restart-closed   reopen closed sessions    /quit   leave (workers keep running)",
  "Anything else goes to Luna, which picks the worker (it is never run as a command).",
].join("\n");

/** What to do next for a worker that cannot take a message. */
const adviceFor = (status) => (status === "finished" ? "Start a new one with /new claude|codex <label> <objective>."
  : status === "dead" ? "Use /restart-closed to reopen closed sessions, or start a new one with /new." : null);

/** Notice text for one `codex.poll()` event, or null. Worker-derived fields go through clean() (no control, escape or bidi characters). */
function noticeOf(e) {
  const w = clean(e.worker_id ?? "?", 80);
  switch (e.type) {
    case "finished": return `${w}: ${clean(e.status ?? e.state ?? "finished", 40)} - ${clean(e.summary ?? "", 200)}${e.blockers?.length ? `; blockers: ${e.blockers.slice(0, 3).map((b) => clean(b, 200)).join(", ")}` : ""}`;
    case "blocked": return `${w}: Codex run blocked (${clean(e.reason ?? e.kind ?? "", 200)})`;
    case "requeued": return `${w}: Codex run re-queued (${clean(e.reason ?? "", 120)})`;
    case "unknown": return `${w}: Codex run ended without a result; check the worktree (${clean(e.reason ?? "", 120)})`;
    case "started": return `${w}: queued Codex run started`;
    default: return null;
  }
}

/**
 * `decisions` is null (Luna routes every non-shortcut line, as before) or an object with `ask(req) -> {byName, usage}`.
 * `store` needs readJsonl and appendJsonl (store.mjs). `workersView() -> Worker[]` and `dispatcher` come from dispatcher.mjs.
 * `codexState()` -> CodexResourceState | null and `costState()` -> {state: "ok"|"soft"|"hard", spent_usd, soft, hard} | null.
 * `poll()` -> Codex adapter events (codex.poll); the CLI calls tick() on a timer.
 */
export function createCoordinator({ cfg, store, provider, dispatcher, workersView, codexState = () => null, costState = () => null, poll = null, now = () => Date.now(), project = {}, decisions = null }) {
  const iso = () => new Date(now()).toISOString();
  const safe = (f) => { try { return f() ?? null; } catch { return null; } };
  let chain = Promise.resolve(), active = 0, seq = 0;
  const pendingNotices = [];
  const serial = (fn) => { const run = chain.then(fn); chain = run.then(() => {}, () => {}); return run; };
  const focus = () => focusOf(store.readJsonl("workers"));

  // The combined Decisions + Luna spend: "$7.50 (Decisions $5.00, Luna $2.50)" (the split only when the cost state carries it)
  const usd2 = (v) => `$${Number(v).toFixed(2)}`;
  const spendText = (c) => `${usd2(c.spent_usd)}${c.by_api ? ` (Decisions ${usd2(c.by_api.decisions)}, Luna ${usd2(c.by_api.responses)})` : ""}`;
  function costNotices(cost) {
    if (!cost) return [];
    if (cost.state === "hard") return [`Coordinator spend ${spendText(cost)} has reached the monthly hard limit of ${money(cost.hard)}. Model calls are paused; shortcuts, /status and running workers keep working.`];
    if (cost.state === "soft") return [`Coordinator spend ${spendText(cost)} is past the ${money(cost.soft)} monthly soft limit (hard limit ${money(cost.hard)}).`];
    return [];
  }
  // Whether the last reply saw Codex unavailable: the notice is shown when that changes (and in /status), not on every reply.
  let wasUnavailable = false;
  function codexNotices(cs, { status = false } = {}) {
    if (!cs) return [];
    const out = [];
    const unavailable = cs.available === false, changed = unavailable !== wasUnavailable;
    wasUnavailable = unavailable;
    if (unavailable) { if (changed || status) out.push(`Codex is unavailable right now (${cfg.codex?.fallback === "refuse" ? "new Codex workers are refused" : "new Codex workers start as Claude workers"}).`); }
    else {
      if (changed) out.push("Codex is available again.");
      if (cs.max_parallel_jobs > 0 && cs.active_jobs >= cs.max_parallel_jobs) out.push(`Codex is busy (${cs.active_jobs} of ${cs.max_parallel_jobs} jobs): new runs queue.`);
    }
    if (cs.usage_status && !["ok", "unknown"].includes(cs.usage_status)) out.push(`Codex usage is ${cs.usage_status}.`);
    return out;
  }

  const workerList = (ws) => ws.filter((w) => !FINISHED.has(w.status)).map((w) => `${w.id} (${w.status})`).join(", ") || "(none)";

  /** The clarify text after two invalid answers: what is wrong in plain words (codes only), plus the live workers. */
  function invalidClarify(errors, ws) {
    const advice = [];
    for (const e of errors) {
      if (e.code !== "target-not-messageable") continue;
      const id = String(e.detail ?? "").split(" ")[0], w = ws.find((x) => x.id === id);
      const a = w && adviceFor(w.status);
      if (a) advice.push(`${w.id} is ${w.status}. ${a}`);
    }
    return `${advice.length ? `${advice.join(" ")} ` : "I could not turn that into a valid action. "}Workers: ${workerList(ws)}. ${SHORTCUTS}`;
  }

  async function turn(text, turnId) {
    const line = String(text ?? "");
    // The newest pending notice, read now: this turn empties pendingNotices when it ends, so the Decisions request shows an event
    // once (as "Last event") and the next turn shows none.
    const lastEvent = pendingNotices.at(-1) ?? null;
    // Turn idempotency, before any resolver branch (error, command, shortcut or model) and before any model call: a replayed turn
    // (same turnId) must not run again. Its line can resolve differently the second time (a shortcut now that a worker finished, a
    // regenerated model decision with a suffixed label) and the dispatcher's request id hashes the decision, so only this turn-level
    // guard keeps one dispatch and one exchange line per turn. It returns the stored reply and writes nothing.
    // No production caller passes a turnId today (cli.mjs calls handleLine(text) and gets a fresh id), so this guard serves callers
    // that retry a turn. Known residual: a crash between `dispatch` and the exchange append below leaves no line to find here; the
    // dispatcher's request-id idempotency then covers a replay that regenerates the same decision.
    const ledger = store.readJsonl("exchanges");
    const prior = ledger.find((e) => e.turn_id === turnId);
    if (prior) return { reply: String(prior.reply ?? ""), notices: [], path: prior.path ?? null, replayed: true };
    const workers = await workersView();
    const focusedId = focus();
    const exchanges = ledger.slice(-20);
    const r = resolveLine(line, { workers, focusedId, exchanges });
    const out = { reply: "", notices: [] };
    let rule = null, decision = null, dispatched = null;
    const outcome = { path: null, meta: null }; // which route produced the reply; the Decisions route numbers

    // `opts.workers`: the list this decision is checked against and dispatched with (default: the turn's snapshot)
    const run = async (d, opts = {}) => {
      const ws = opts.workers ?? workers;
      decision = d;
      const dup = dispatcher.peek(d, { turnId });
      if (!dup) {
        const v = validateForDispatch(d, { workers: ws, verbatim: !!opts.verbatim });
        if (!v.ok) { decision = null; return { reply: invalidClarify(v.errors, ws) }; }
      }
      dispatched = dup ?? await dispatcher.dispatch(d, { turnId, workers: ws, ...(opts.inWorktreeOf ? { inWorktreeOf: opts.inWorktreeOf } : {}) });
      return { reply: dispatched.reply };
    };

    if (r.kind === "error") {
      rule = "error"; outcome.path = "error";
      const m = /^(\S+) is (finished|dead) and cannot take a message\.$/.exec(r.reply);
      out.reply = m ? `${r.reply} ${adviceFor(m[2])}` : r.reply;
    } else if (r.kind === "command") {
      rule = "command"; outcome.path = "command";
      if (r.command === "workers") out.reply = await dispatcher.status([], workers);
      else if (r.command === "help") out.reply = HELP;
      else if (r.command === "quit") { out.reply = "Leaving the coordinator. Workers keep running."; out.command = "quit"; }
      else if (r.command === "restart-closed") { out.reply = "Reopening closed sessions..."; out.command = "restart-closed"; }
      else out.reply = HELP;
    } else if (r.kind === "decision") {
      rule = r.rule ?? "command"; outcome.path = "shortcut";
      const res = await run(r.decision, { verbatim: r.verbatim, inWorktreeOf: r.inWorktreeOf });
      out.reply = res.reply;
    } else {
      const cost = safe(costState); // read once; the routing choice below uses only this value
      if (cost?.state === "hard") {
        out.reply = `${costNotices(cost)[0]} ${SHORTCUTS}`; outcome.path = "shortcuts-only";
      } else if (decisions) {
        out.reply = await viaDecisions(line, r, workers, focusedId, exchanges, run, (d) => { decision = d; }, outcome, lastEvent);
      } else {
        out.reply = await viaModel(line, r, workers, focusedId, exchanges, (d) => run(d), (d) => { decision = d; }, { cost });
        outcome.path = "luna";
      }
    }

    if (decision?.action === "request_status") { // every status reply (the /status shortcut or a Decisions status route) carries the spend
      const c = safe(costState);
      if (c) out.reply = `${out.reply}
Spend this month: ${spendText(c)} of ${money(c.soft)} soft / ${money(c.hard)} hard - ${STATE_WORD[c.state] ?? STATE_WORD.ok}`;
    }

    const exAction = decision?.action ?? (rule === "error" ? "clarify" : null);
    const created = dispatched?.results?.find((x) => x.ok && x.target)?.target;
    const targets = decision?.action === "create_session" ? (created ? [created] : []) : decision?.target_session_ids ?? [];
    store.appendJsonl("exchanges", { turn_id: turnId, at: iso(), user: cap(line, 2000), reply: cap(out.reply, 2000), action: exAction, targets,
      instruction: decision?.worker_instruction == null ? null : cap(decision.worker_instruction, 4000), rule: rule ?? "model", path: outcome.path,
      ...(outcome.meta && Number.isFinite(outcome.meta.p1) ? { route_p1: round3(outcome.meta.p1), route_margin: round3(outcome.meta.margin) } : {}) });

    // read again here (not the gate's value above): this turn's own model spend may have crossed a limit
    const cost = safe(costState);
    // at the hard limit the reply already opens with the hard notice: do not repeat it as a notice
    const costN = costNotices(cost).filter((n) => !(cost?.state === "hard" && out.reply.startsWith(n)));
    out.notices = [...pendingNotices.splice(0), ...costN, ...codexNotices(safe(codexState), { status: decision?.action === "request_status" })];
    if (decision) out.decision = decision;
    if (dispatched) out.dispatched = dispatched;
    if (rule) out.rule = rule;
    out.path = outcome.path;
    return out;
  }

  /**
   * The Luna branch. Returns the reply text. `run(d)` validates and dispatches; `setDecision` records what the exchange shows.
   * `minConfidence` replaces cfg.min_confidence (the fallback after Decisions uses a stricter bar); `onHardLimit` runs when the cost gate refuses the call; `cost` is the turn's cost state
   * when the caller already read it (the fallback reads it fresh: the Decisions call may have spent).
   */
  async function viaModel(line, r, workers, focusedId, exchanges, run, setDecision, { minConfidence = cfg.min_confidence, cost: given, onHardLimit = null } = {}) {
    const cost = given !== undefined ? given : safe(costState);
    if (cost?.state === "hard") { onHardLimit?.(); return `${costNotices(cost)[0]} ${SHORTCUTS}`; }
    const input = (validationErrors) => buildInput({
      cfg, project: { repo: project.repo ?? null, codex: safe(codexState), cost }, workers, focusedId, referents: r.referents, exchanges, message: line, now: now(),
      ...(validationErrors ? { validationErrors } : {}),
    });
    let d;
    try {
      let v;
      d = await provider.decide(input());
      v = validateDecision(d, { workers });
      if (!v.ok) { // one re-ask with the errors (codes and fields only), then a clarify
        d = await provider.decide(input(v.errors.map(({ code, field }) => ({ code, field }))));
        v = validateDecision(d, { workers });
        if (!v.ok) return invalidClarify(v.errors, workers);
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.code === "hard-limit") onHardLimit?.(); // Luna's own meter reached the hard limit (the gate above read ok): no model answered
        return `Luna is unavailable (${e.code}: ${e.message}). ${SHORTCUTS}`;
      }
      if (e?.message === "context-over-budget") return `That message is too large for Luna's context, so I did not send it. ${SHORTCUTS}`;
      throw e;
    }
    if (lowConfidence(d, minConfidence)) {
      setDecision({ ...d, action: "clarify" });
      return d.clarification ?? `Which worker do you mean? Workers: ${workerList(workers)}.`;
    }
    const res = await run(d);
    return res.reply;
  }

  /** The Decisions branch (Task 4a). Sets outcome.path (and outcome.meta) and returns the reply text. */
  async function viaDecisions(rawLine, r, workers, focusedId, exchanges, run, setDecision, outcome, lastEvent) {
    // One cleaned text for everything that follows: what is routed equals what is dispatched (and the Luna fallback sees it too).
    const line = cleanLine(rawLine);
    if (!line.trim()) { // only control characters (or nothing): nothing to route, so no model call
      outcome.path = "shortcuts-only";
      return `I got no text to route. ${SHORTCUTS}`;
    }
    const req = buildDecisionsRequest({ workers, focusedId, referents: r.referents, exchanges, lastEvent, message: line, codexEligible: codexEligible(safe(codexState)), cfg });
    if (req.tooLong) {
      outcome.path = "shortcuts-only";
      return `That is too long for me to route automatically (limit ${cfg.decisions.max_message_chars} characters). ${SHORTCUTS}`;
    }
    // The Luna fallback: the model call can take seconds, so its decision is validated and dispatched against a view fetched AFTER
    // that call (never the turn's snapshot, never the view from before the call). When the fallback's own cost gate finds the hard
    // limit (the failed Decisions attempts were metered), no model call is made and the path is shortcuts-only, as for a Decisions SpendBlocked.
    const fallback = () => {
      outcome.path = "luna-fallback"; outcome.meta = null;
      return viaModel(line, r, workers, focusedId, exchanges, async (d) => run(d, { workers: await workersView() }), setDecision,
        { minConfidence: Math.max(cfg.min_confidence, cfg.decisions.fallback_min_confidence), onHardLimit: () => { outcome.path = "shortcuts-only"; outcome.meta = null; } });
    };
    let ans;
    try { ans = await decisions.ask(req); } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (e.code === "hard-limit") { // SpendBlocked: no Decisions call and no Luna call
        outcome.path = "shortcuts-only";
        return `Routing is paused (${e.message}). No model call was made. Shortcuts, /status and running workers keep working. ${SHORTCUTS}`;
      }
      return fallback();
    }
    const fresh = await workersView(); // a worker may have finished while Decisions was thinking
    const res = interpretAnswers(ans?.byName, { offered: req.offered, workers: fresh, focusedId, referents: r.referents, message: line, cfg });
    if (res.kind === "unusable") return fallback();
    outcome.path = "decisions"; outcome.meta = res.meta;
    if (res.kind === "clarify" || res.kind === "advice") {
      setDecision(emptyDecision({ action: "clarify", clarification: res.text.slice(0, 500) }));
      return res.text;
    }
    if (res.writer !== null) return writeWith(res, { run, setDecision, workers: fresh, line, referents: r.referents, focusedId, exchanges });
    const d = res.decision;
    return (await run(d, { verbatim: d.action === "message_session" || d.action === "message_multiple", workers: fresh })).reply;
  }

  /**
   * The writer (Task 4b): Luna writes only text for a route that code already decided (pinned_route in its input). Its answer is
   * merged field by field into `res.decision`: respond takes `reply`; create_session takes new_session.label, new_session.objective
   * and worker_instruction (each only when a string). The action, targets, new_session.needed and new_session.provider always come
   * from `res.decision`, so writer text never sets a route and is never executed. The decision is validated against the FRESH
   * workers list; one invalid answer gets one re-ask; a provider failure (the re-ask included) takes the failure path. The turn
   * dispatches at most once: `run(final)` is the only dispatch, and the failure paths dispatch `res.decision` (brief) or reply.
   */
  async function writeWith(res, { run, setDecision, workers, line, referents, focusedId, exchanges }) {
    const base = res.decision, brief = res.writer === "brief";
    const cost = safe(costState);
    const pinnedRoute = { action: base.action, target_session_ids: base.target_session_ids, provider: base.new_session?.provider ?? null, write: brief ? "brief" : "reply" };
    const input = (validationErrors) => buildInput({
      cfg, project: { repo: project.repo ?? null, codex: safe(codexState), cost }, workers, focusedId, referents, exchanges, message: line, now: now(), pinnedRoute,
      ...(validationErrors ? { validationErrors } : {}),
    });
    const str = (v) => (typeof v === "string" ? v : null);
    const merge = (w) => {
      const o = w && typeof w === "object" ? w : {};
      if (!brief) return { ...base, reply: str(o.reply) ?? "" };
      const ns = o.new_session && typeof o.new_session === "object" ? o.new_session : {};
      const label = str(ns.label), objective = str(ns.objective), instruction = str(o.worker_instruction);
      return { ...base, worker_instruction: instruction ?? base.worker_instruction,
        new_session: { ...base.new_session, label: label ?? base.new_session.label, objective: objective ?? base.new_session.objective } };
    };
    const check = (d) => {
      const v = validateDecision(d, { workers });
      if (!brief && !d.reply.trim()) v.errors = [...(v.errors ?? []), { code: "empty", field: "reply" }]; // a respond with no text says nothing
      return { ok: v.ok && !(v.errors?.length), errors: v.errors ?? [] };
    };
    let final = null, failure = null;
    try {
      if (cost?.state === "hard") failure = "hard-limit"; // the provider would refuse as well; no call is made
      else {
        let cand = merge(await provider.decide(input())), v = check(cand);
        if (!v.ok) { // one re-ask with the error codes (codes and fields only)
          cand = merge(await provider.decide(input(v.errors.map(({ code, field }) => ({ code, field })))));
          v = check(cand);
        }
        if (v.ok) final = cand;
      }
    } catch (e) {
      if (e instanceof ProviderError) failure = e.code;
      else if (e?.message === "context-over-budget") failure = "context-over-budget";
      else throw e;
    }
    if (final) return (await run(final, { workers })).reply;
    if (brief) return (await run(base, { workers })).reply;
    const text = failure ? `Luna is unavailable (${failure}). ${SHORTCUTS}` : `I could not write an answer. ${SHORTCUTS}`;
    setDecision(emptyDecision({ action: "clarify", clarification: text.slice(0, 500) }));
    return text;
  }

  function handleLine(text, { turnId } = {}) {
    const id = turnId ?? `t-${now()}-${++seq}`;
    active++;
    return serial(() => turn(text, id)).finally(() => { active--; });
  }

  /**
   * Polls Codex between turns (the CLI calls it on a timer). It is skipped while a line is in flight or queued, so a poll never
   * delays a reply that is already pending. A line that arrives while a poll runs waits for it: codex.poll holds the Codex write
   * lock across the synchronous `codex login status` probe (up to 15 s) and `git worktree add`, so that stall is bounded by
   * those two, and the line is then handled in order. Events become notices on the next reply.
   */
  function tick() {
    if (!poll || active > 0) return Promise.resolve({ skipped: true, events: [], notices: [] });
    active++;
    return serial(async () => {
      const events = (await poll()) ?? [];
      const notices = events.map(noticeOf).filter(Boolean);
      pendingNotices.push(...notices);
      return { skipped: false, events, notices };
    }).finally(() => { active--; });
  }

  return { handleLine, tick, focus };
}
