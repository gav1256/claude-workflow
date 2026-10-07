// The turn loop: one user line in, one reply out. resolveLine (no model) decides shortcuts; anything else goes to the provider
// (Luna) as one strict decision per call, is validated, re-asked once on errors, and dispatched by the dispatcher.
// Lines are handled strictly one at a time (a promise chain): two overlapping lines can never both pass the spend check against
// the same spend. Imports only provider.mjs for the provider contract (ProviderError); it never touches a file except through the
// store it is given (the exchanges ledger).
import { resolveLine } from "./resolve.mjs";
import { buildInput } from "./context.mjs";
import { validateDecision, lowConfidence, FINISHED } from "./validate.mjs";
import { focusOf } from "./workers.mjs";
import { ProviderError } from "./provider.mjs";

const cap = (s, n) => String(s ?? "").slice(0, n);
const money = (v) => `$${Number(v).toFixed(2).replace(/\.00$/, "")}`;
const SHORTCUTS = "Use /to <id> <text>, /status, /new claude|codex <label> <objective>.";

/**
 * validateDecision with one exception: a `verbatim` decision (a /to shortcut) may carry a worker_instruction longer than the
 * model limit, because the delivery path owns long texts. Only "too-long" on worker_instruction is ignored; every other check
 * (targets, control characters, label, ...) still applies, to the full text and to a capped copy (a shape error hides the
 * semantic ones, so the capped copy is checked as well).
 */
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

/** Notice text for one `codex.poll()` event, or null. */
function noticeOf(e) {
  const w = e.worker_id ?? "?";
  switch (e.type) {
    case "finished": return `${w}: ${e.status ?? e.state ?? "finished"} - ${cap(e.summary ?? "", 200)}${e.blockers?.length ? `; blockers: ${e.blockers.slice(0, 3).join(", ")}` : ""}`;
    case "blocked": return `${w}: Codex run blocked (${cap(e.reason ?? e.kind ?? "", 200)})`;
    case "requeued": return `${w}: Codex run re-queued (${cap(e.reason ?? "", 120)})`;
    case "unknown": return `${w}: Codex run ended without a result; check the worktree (${cap(e.reason ?? "", 120)})`;
    case "started": return `${w}: queued Codex run started`;
    default: return null;
  }
}

/**
 * `store` needs readJsonl and appendJsonl (store.mjs). `workersView() -> Worker[]` and `dispatcher` come from dispatcher.mjs.
 * `codexState()` -> CodexResourceState | null and `costState()` -> {state: "ok"|"soft"|"hard", spent_usd, soft, hard} | null.
 * `poll()` -> Codex adapter events (codex.poll); the CLI calls tick() on a timer.
 */
export function createCoordinator({ cfg, store, provider, dispatcher, workersView, codexState = () => null, costState = () => null, poll = null, now = () => Date.now(), project = {} }) {
  const iso = () => new Date(now()).toISOString();
  const safe = (f) => { try { return f() ?? null; } catch { return null; } };
  let chain = Promise.resolve(), active = 0, seq = 0;
  const pendingNotices = [];
  const serial = (fn) => { const run = chain.then(fn); chain = run.then(() => {}, () => {}); return run; };
  const focus = () => focusOf(store.readJsonl("workers"));

  function costNotices(cost) {
    if (!cost) return [];
    if (cost.state === "hard") return [`Luna is paused: the monthly hard limit of ${money(cost.hard)} is reached (${money(cost.spent_usd)} spent). Shortcuts, /status and running workers keep working.`];
    if (cost.state === "soft") return [`Luna spend ${money(cost.spent_usd)} is past the ${money(cost.soft)} monthly soft limit (hard limit ${money(cost.hard)}).`];
    return [];
  }
  function codexNotices(cs) {
    if (!cs) return [];
    const out = [];
    if (cs.available === false) out.push(`Codex is unavailable right now (${cfg.codex?.fallback === "refuse" ? "new Codex workers are refused" : "new Codex workers start as Claude workers"}).`);
    else if (cs.max_parallel_jobs > 0 && cs.active_jobs >= cs.max_parallel_jobs) out.push(`Codex is busy (${cs.active_jobs} of ${cs.max_parallel_jobs} jobs): new runs queue.`);
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
    const workers = await workersView();
    const focusedId = focus();
    const exchanges = store.readJsonl("exchanges").slice(-20);
    const r = resolveLine(line, { workers, focusedId, exchanges });
    const out = { reply: "", notices: [] };
    let rule = null, decision = null, dispatched = null;

    const run = async (d, opts = {}) => {
      decision = d;
      const dup = dispatcher.peek(d, { turnId });
      if (!dup) {
        const v = validateForDispatch(d, { workers, verbatim: !!opts.verbatim });
        if (!v.ok) { decision = null; return { reply: invalidClarify(v.errors, workers) }; }
      }
      dispatched = dup ?? await dispatcher.dispatch(d, { turnId, workers, ...(opts.inWorktreeOf ? { inWorktreeOf: opts.inWorktreeOf } : {}) });
      return { reply: dispatched.reply };
    };

    if (r.kind === "error") {
      rule = "error";
      const m = /^(\S+) is (finished|dead) and cannot take a message\.$/.exec(r.reply);
      out.reply = m ? `${r.reply} ${adviceFor(m[2])}` : r.reply;
    } else if (r.kind === "command") {
      rule = "command";
      if (r.command === "workers") out.reply = await dispatcher.status([], workers);
      else if (r.command === "help") out.reply = HELP;
      else if (r.command === "quit") { out.reply = "Leaving the coordinator. Workers keep running."; out.command = "quit"; }
      else if (r.command === "restart-closed") { out.reply = "Reopening closed sessions..."; out.command = "restart-closed"; }
      else out.reply = HELP;
    } else if (r.kind === "decision") {
      rule = r.rule ?? "command";
      const res = await run(r.decision, { verbatim: r.verbatim, inWorktreeOf: r.inWorktreeOf });
      out.reply = res.reply;
    } else {
      out.reply = await viaModel(line, r, workers, focusedId, exchanges, (d) => run(d), (d) => { decision = d; });
    }

    const exAction = decision?.action ?? (rule === "error" ? "clarify" : null);
    const created = dispatched?.results?.find((x) => x.ok && x.target)?.target;
    const targets = decision?.action === "create_session" ? (created ? [created] : []) : decision?.target_session_ids ?? [];
    store.appendJsonl("exchanges", { turn_id: turnId, at: iso(), user: cap(line, 2000), reply: cap(out.reply, 2000), action: exAction, targets,
      instruction: decision?.worker_instruction == null ? null : cap(decision.worker_instruction, 4000), rule: rule ?? "model" });

    const cost = safe(costState);
    out.notices = [...pendingNotices.splice(0), ...costNotices(cost), ...codexNotices(safe(codexState))];
    if (decision) out.decision = decision;
    if (dispatched) out.dispatched = dispatched;
    if (rule) out.rule = rule;
    return out;
  }

  /** The model branch. Returns the reply text. `run(d)` validates and dispatches; `setDecision` records what the exchange shows. */
  async function viaModel(line, r, workers, focusedId, exchanges, run, setDecision) {
    const cost = safe(costState);
    if (cost?.state === "hard") return `${costNotices(cost)[0]} No model call was made. ${SHORTCUTS}`;
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
      if (e instanceof ProviderError) return `Luna is unavailable (${e.code}: ${e.message}). ${SHORTCUTS}`;
      if (e?.message === "context-over-budget") return `That message is too large for Luna's context, so I did not send it. ${SHORTCUTS}`;
      throw e;
    }
    if (lowConfidence(d, cfg.min_confidence)) {
      setDecision({ ...d, action: "clarify" });
      return d.clarification ?? `Which worker do you mean? Workers: ${workerList(workers)}.`;
    }
    const res = await run(d);
    return res.reply;
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
