// Deterministic routing (no model call) and the coreference helpers. Pure: no file access, no clock.
//
// resolveLine decides, in order: a slash command, a line that names exactly one worker, "continue" with a single
// messageable worker. Anything else returns {kind: "model", referents} for Luna. A deterministic decision has
// confidence 1; the caller still runs it through validateDecision.
import { emptyDecision, LABEL_RE, ALIAS_RE, LIMITS } from "./schema.mjs";
import { validateDecision, MESSAGEABLE, FINISHED } from "./validate.mjs";

const list = (w) => (w instanceof Map ? [...w.values()] : Array.isArray(w) ? w : []);
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NAME_EDGE = String.raw`[\p{L}\p{N}_-]`; // glues a name to its neighbours
const live = (w) => !FINISHED.has(w.status);
const messageable = (w) => MESSAGEABLE.has(w.status);

// ---- commands -------------------------------------------------------------------------------------------------

const REF = String.raw`(?:"[^"]+"|[^\s,"]+)`;
const REFS = String.raw`${REF}(?:,${REF})*`;
const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
const splitRefs = (s) => (s.match(new RegExp(REF, "g")) ?? []).map(unquote);

/** @returns {null | object} null when the text is not a well-formed command (resolveLine turns a bad one into a usage error). */
export function parseCommand(text) {
  const t = String(text ?? "").trim();
  if (!t.startsWith("/")) return null;
  let m;
  if ((m = new RegExp(String.raw`^/to\s+(${REFS})\s+([\s\S]+)$`).exec(t))) return { cmd: "to", targets: splitRefs(m[1]), text: m[2].trim() };
  if ((m = /^\/status(?:\s+([\s\S]+))?$/.exec(t))) {
    const rest = (m[1] ?? "").trim();
    if (rest && !new RegExp(String.raw`^${REF}(?:[\s,]+${REF})*$`).test(rest)) return null;
    return { cmd: "status", targets: rest ? splitRefs(rest) : [] };
  }
  if ((m = new RegExp(String.raw`^/new\s+(claude|codex)\s+(\S+)(?:\s+--in\s+(${REF}))?\s+([\s\S]+)$`, "i").exec(t))) {
    const out = { cmd: "new", provider: m[1].toLowerCase(), label: m[2], objective: m[4].trim() };
    if (m[3]) out.inWorktreeOf = unquote(m[3]);
    return out;
  }
  if ((m = new RegExp(String.raw`^/alias\s+(${REF})\s+([\s\S]+)$`).exec(t))) return { cmd: "alias", target: unquote(m[1]), alias: m[2].trim() };
  if (/^\/(restart-closed|workers|help|quit)\s*$/.test(t)) return { cmd: t.slice(1).trim() };
  return null;
}

const USAGE = {
  to: "Usage: /to <worker>[,<worker>...] <text>",
  status: "Usage: /status [<worker>...]",
  new: "Usage: /new claude|codex <label> [--in <worker>] <objective>",
  alias: "Usage: /alias <worker> <alias>",
};

/** @returns {{id: string} | {ambiguous: string[]} | {none: true}} exact id, then exact label, then alias (labels and aliases: live workers only). */
export function matchRef(ref, workers) {
  const ws = list(workers), r = String(ref ?? "").trim();
  const byId = ws.find((w) => w.id === r);
  if (byId) return { id: byId.id };
  const lc = r.toLowerCase();
  const pick = (hits) => (hits.length === 1 ? { id: hits[0].id } : hits.length > 1 ? { ambiguous: hits.map((w) => w.id) } : null);
  return pick(ws.filter((w) => live(w) && String(w.label ?? "").toLowerCase() === lc))
    ?? pick(ws.filter((w) => live(w) && (w.aliases ?? []).some((a) => String(a).toLowerCase() === lc)))
    ?? { none: true };
}

const workerList = (ws) => ws.filter(live).map((w) => `${w.id} (${w.status})`).join(", ") || "(none)";
const refError = (ref, hit, ws) => hit.ambiguous
  ? { kind: "error", reply: `"${ref}" matches more than one worker: ${hit.ambiguous.join(", ")}. Use the id.` }
  : { kind: "error", reply: `No worker named ${ref}. Workers: ${workerList(ws)}` };
const invalidReply = (errors) => `Cannot do that: ${errors.map((e) => `${e.code} ${e.field}${e.detail !== undefined ? ` (${e.detail})` : ""}`).join("; ")}`;

function runCommand(cmd, ws) {
  const ok = (decision, extra = {}) => ({ kind: "decision", decision, rule: "command", ...extra });
  const checked = (decision, extra) => {
    const v = validateDecision(decision, { workers: ws });
    return v.ok ? ok(decision, extra) : { kind: "error", reply: invalidReply(v.errors) };
  };
  switch (cmd.cmd) {
    case "to": {
      const ids = [];
      for (const ref of cmd.targets) {
        const hit = matchRef(ref, ws);
        if (!hit.id) return refError(ref, hit, ws);
        if (!ids.includes(hit.id)) ids.push(hit.id);
      }
      if (ids.length > LIMITS.targets) return { kind: "error", reply: `At most ${LIMITS.targets} workers per /to.` };
      for (const id of ids) {
        const w = ws.find((x) => x.id === id);
        if (!messageable(w)) return { kind: "error", reply: `${id} is ${w.status} and cannot take a message.` };
      }
      // The text goes verbatim and may exceed the instruction limit (the delivery path owns long texts), so the only
      // error ignored is "too-long" on worker_instruction. The rest of the validator still runs on a capped copy, so
      // target and control-character checks hold for long texts too. `verbatim: true` tells the dispatcher.
      const d = emptyDecision({
        action: ids.length === 1 ? "message_session" : "message_multiple", reply: `Sending to ${ids.join(", ")}.`,
        target_session_ids: ids, worker_instruction: cmd.text,
      });
      const full = validateDecision(d, { workers: ws });
      const errors = full.errors.filter((e) => !(e.code === "too-long" && e.field === "worker_instruction"));
      if (errors.length < full.errors.length) { // shape errors hide the semantic ones: re-check a capped copy
        const capped = validateDecision({ ...d, worker_instruction: cmd.text.slice(0, LIMITS.worker_instruction) }, { workers: ws });
        for (const e of capped.errors) if (!errors.some((x) => x.code === e.code && x.field === e.field)) errors.push(e);
      }
      return errors.length ? { kind: "error", reply: invalidReply(errors) } : ok(d, { verbatim: true });
    }
    case "status": {
      const ids = [];
      for (const ref of cmd.targets) {
        const hit = matchRef(ref, ws);
        if (!hit.id) return refError(ref, hit, ws);
        if (!ids.includes(hit.id)) ids.push(hit.id);
      }
      return checked(emptyDecision({ action: "request_status", target_session_ids: ids }));
    }
    case "new": {
      let inWorktreeOf;
      if (cmd.inWorktreeOf) {
        const hit = matchRef(cmd.inWorktreeOf, ws);
        if (!hit.id) return refError(cmd.inWorktreeOf, hit, ws);
        inWorktreeOf = hit.id;
      }
      if (!LABEL_RE.test(cmd.label)) return { kind: "error", reply: `Bad label "${cmd.label}": use lowercase letters, digits and hyphens (3-32 characters).` };
      return checked(emptyDecision({
        action: "create_session", reply: `Creating ${cmd.provider} worker ${cmd.label}.`,
        new_session: { needed: true, provider: cmd.provider, label: cmd.label, objective: cmd.objective },
      }), inWorktreeOf ? { inWorktreeOf } : {});
    }
    case "alias": {
      const hit = matchRef(cmd.target, ws);
      if (!hit.id) return refError(cmd.target, hit, ws);
      const alias = cmd.alias.toLowerCase().replace(/\s+/g, " ");
      if (!ALIAS_RE.test(alias)) return { kind: "error", reply: `Bad alias "${cmd.alias}": use lowercase letters, digits, spaces and hyphens.` };
      return checked(emptyDecision({
        reply: `"${alias}" now means ${hit.id}.`,
        record_update: { aliases: [{ session_id: hit.id, alias }], focus: null, note: null },
      }));
    }
    default:
      return { kind: "command", command: cmd.cmd };
  }
}

// ---- names in free text -----------------------------------------------------------------------------------------

/**
 * Workers whose id (any status), or label / alias (live workers only), appears in `text` as a whole word (Unicode
 * letters and digits, "_" and "-" glue a name to its neighbours). Returns id -> {rule, pos}: the best rule
 * (explicit-id > exact-name > alias) and the start of the LAST matched name (so the latest mention can be ranked).
 */
function mentions(text, ws) {
  const out = new Map();
  const rank = { "explicit-id": 0, "exact-name": 1, alias: 2 };
  const last = (name) => {
    if (!name) return -1;
    let at = -1;
    for (const m of text.matchAll(new RegExp(`(?<!${NAME_EDGE})${escRe(String(name))}(?!${NAME_EDGE})`, "giu"))) at = m.index;
    return at;
  };
  const add = (id, rule, pos) => {
    if (pos < 0) return;
    const cur = out.get(id);
    out.set(id, { rule: !cur || rank[rule] < rank[cur.rule] ? rule : cur.rule, pos: Math.max(pos, cur?.pos ?? -1) });
  };
  for (const w of ws) {
    add(w.id, "explicit-id", last(w.id));
    if (!live(w)) continue;
    add(w.id, "exact-name", last(w.label));
    for (const a of w.aliases ?? []) add(w.id, "alias", last(a));
  }
  return out;
}

// ---- coreference ------------------------------------------------------------------------------------------------

const PRON_BOTH = /\b(both|each of them|all of them)\b/i;
const PRON_OTHER = /\bthe other (one|worker|session)\b/i;
const PRON_ONE = /\b(him|her|it|that one|this one|that worker|them)\b/i;
export const pronounOf = (text) => {
  const t = String(text ?? "");
  return PRON_BOTH.test(t) ? "both" : PRON_OTHER.test(t) ? "other" : PRON_ONE.test(t) ? "singular" : null;
};

/** `exchanges` run oldest first. A worker is mentioned by an exchange's targets, or by name in its user text or reply. */
export function referents({ text, workers, focusedId = null, exchanges = [] } = {}) {
  const ws = list(workers), byId = new Map(ws.map((w) => [w.id, w]));
  const recent = [];
  const seen = (id) => { if (byId.has(id) && messageable(byId.get(id)) && !recent.includes(id)) recent.push(id); };
  const ex = Array.isArray(exchanges) ? exchanges : [];
  for (let i = ex.length - 1; i >= 0; i--) {
    const e = ex[i] ?? {};
    // inside one exchange the name that comes last in the text is the most recent; targets the text does not name follow
    const said = `${e.user ?? ""}\n${e.reply ?? ""}`;
    for (const [id] of [...mentions(said, ws)].sort((a, b) => b[1].pos - a[1].pos)) seen(id);
    for (const id of Array.isArray(e.targets) ? e.targets : []) seen(id);
  }
  const singular = focusedId && byId.has(focusedId) && messageable(byId.get(focusedId)) ? focusedId : recent[0] ?? null;
  const last = ex.length ? ex[ex.length - 1] : null;
  return {
    pronoun: pronounOf(text),
    singular,
    other: recent.find((id) => id !== singular) ?? null,
    both: recent.length >= 2 ? recent.slice(0, 2) : null,
    recent,
    last_instruction: last && typeof last.instruction === "string" ? last.instruction : null,
  };
}

// ---- resolveLine ------------------------------------------------------------------------------------------------

const CONTINUE = /^(continue|keep going|go on|carry on|proceed)[.!]*$/i;
// A question about a worker ("what did the auth worker say?") is for Luna to answer, not a message for the worker.
const QUESTION = /\?\s*$|^\s*(what|how|where|why|when|who|which|show)\b/i;

export function resolveLine(text, { workers, focusedId = null, exchanges = [] } = {}) {
  const ws = list(workers), line = String(text ?? "").trim();
  if (line.startsWith("/")) {
    const cmd = parseCommand(line);
    if (cmd) return runCommand(cmd, ws);
    const name = /^\/([\w-]*)/.exec(line)?.[1] ?? "";
    return { kind: "error", reply: USAGE[name] ?? `Unknown command /${name}. Try /help.` };
  }
  const refs = () => ({ kind: "model", referents: referents({ text: line, workers: ws, focusedId, exchanges }) });
  const send = (id, rule) => {
    const decision = emptyDecision({ action: "message_session", reply: `Sending to ${id}.`, target_session_ids: [id], worker_instruction: line });
    return validateDecision(decision, { workers: ws }).ok ? { kind: "decision", decision, rule } : null;
  };

  const named = mentions(line, ws);
  if (named.size === 1 && !pronounOf(line) && !QUESTION.test(line)) {
    const [[id, { rule }]] = [...named];
    const hit = ws.find((w) => w.id === id);
    if (messageable(hit)) { const r = send(id, rule); if (r) return r; }
    return refs();
  }
  if (named.size === 0 && CONTINUE.test(line)) {
    // exactly one messageable, non-queued worker, and it is not failed ("continue" after a failure is a model question)
    const open = ws.filter((w) => messageable(w) && w.status !== "queued");
    if (open.length === 1 && open[0].status !== "failed") { const r = send(open[0].id, "continue-single"); if (r) return r; }
  }
  return refs();
}
