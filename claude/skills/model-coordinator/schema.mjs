export const ACTIONS = ["respond", "message_session", "message_multiple", "create_session", "request_status", "clarify"];
export const PROVIDERS = ["claude", "codex"];
export const LIMITS = { reply: 2000, worker_instruction: 4000, label: 32, objective: 1000, clarification: 500, targets: 8,
  aliases: 8, session_id: 48, note: 300 };
export const LABEL_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const ALIAS_RE = /^[a-z][a-z0-9 -]{0,38}[a-z0-9]$/;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const nstr = { type: ["string", "null"] };
export const DECISION_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["action", "reply", "target_session_ids", "worker_instruction", "new_session", "confidence", "clarification", "record_update"],
  properties: {
    action: { type: "string", enum: ACTIONS },
    reply: { type: "string" },
    target_session_ids: { type: "array", items: { type: "string" } },
    worker_instruction: nstr,
    new_session: { type: "object", additionalProperties: false, required: ["needed", "provider", "label", "objective"],
      properties: { needed: { type: "boolean" }, provider: { type: ["string", "null"], enum: ["claude", "codex", null] }, label: nstr, objective: nstr } },
    confidence: { type: "number" },
    clarification: nstr,
    record_update: { anyOf: [{ type: "object", additionalProperties: false, required: ["aliases", "focus", "note"], properties: {
      aliases: { type: "array", items: { type: "object", additionalProperties: false, required: ["session_id", "alias"],
        properties: { session_id: { type: "string" }, alias: { type: "string" } } } },
      focus: nstr, note: nstr } }, { type: "null" }] },
  },
};
export const emptyDecision = (p = {}) => ({ action: "respond", reply: "", target_session_ids: [], worker_instruction: null,
  new_session: { needed: false, provider: null, label: null, objective: null }, confidence: 1, clarification: null, record_update: null,
  ...p, new_session: { needed: false, provider: null, label: null, objective: null, ...(p.new_session ?? {}) } });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function exactKeys(o, keys, at, errs) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push({ code: "unknown-field", field: at + k });
  for (const k of keys) if (!Object.hasOwn(o, k)) errs.push({ code: "missing-field", field: at + k });
}
function text(v, field, max, errs, { nullable = false, nonEmpty = false } = {}) {
  if (v === null && nullable) return;
  if (typeof v !== "string") return void errs.push({ code: "type", field });
  if (v.length > max) errs.push({ code: "too-long", field, detail: `${v.length} > ${max}` });
  if (CTRL.test(v)) errs.push({ code: "control-char", field });
  if (nonEmpty && !v.trim()) errs.push({ code: "empty", field });
}
export function validateShape(d) {
  const errs = [];
  if (!isObj(d)) return { ok: false, errors: [{ code: "type", field: "$" }] };
  exactKeys(d, DECISION_SCHEMA.required, "", errs);
  if (!ACTIONS.includes(d.action)) errs.push({ code: "enum", field: "action" });
  text(d.reply, "reply", LIMITS.reply, errs);
  const t = d.target_session_ids;
  if (!Array.isArray(t) || !t.every((s) => typeof s === "string" && s.length <= LIMITS.session_id)) errs.push({ code: "type", field: "target_session_ids" });
  else if (t.length > LIMITS.targets) errs.push({ code: "too-many", field: "target_session_ids" });
  else if (new Set(t).size !== t.length) errs.push({ code: "duplicate", field: "target_session_ids" });
  text(d.worker_instruction, "worker_instruction", LIMITS.worker_instruction, errs, { nullable: true });
  const ns = d.new_session;
  if (!isObj(ns)) errs.push({ code: "type", field: "new_session" });
  else {
    exactKeys(ns, ["needed", "provider", "label", "objective"], "new_session.", errs);
    if (typeof ns.needed !== "boolean") errs.push({ code: "type", field: "new_session.needed" });
    if (ns.provider !== null && !PROVIDERS.includes(ns.provider)) errs.push({ code: "enum", field: "new_session.provider" });
    text(ns.label, "new_session.label", LIMITS.label, errs, { nullable: true });
    if (typeof ns.label === "string" && !LABEL_RE.test(ns.label)) errs.push({ code: "pattern", field: "new_session.label" });
    text(ns.objective, "new_session.objective", LIMITS.objective, errs, { nullable: true });
  }
  if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) errs.push({ code: "range", field: "confidence" });
  text(d.clarification, "clarification", LIMITS.clarification, errs, { nullable: true });
  const ru = d.record_update;
  if (ru !== null && Object.hasOwn(d, "record_update")) {
    if (!isObj(ru)) errs.push({ code: "type", field: "record_update" });
    else {
      exactKeys(ru, ["aliases", "focus", "note"], "record_update.", errs);
      if (!Array.isArray(ru.aliases) || ru.aliases.length > LIMITS.aliases) errs.push({ code: "type", field: "record_update.aliases" });
      else ru.aliases.forEach((a, i) => {
        const at = `record_update.aliases.${i}`;
        if (!isObj(a)) return void errs.push({ code: "type", field: at });
        exactKeys(a, ["session_id", "alias"], `${at}.`, errs);
        text(a.session_id, `${at}.session_id`, LIMITS.session_id, errs, { nonEmpty: true });
        if (typeof a.alias !== "string" || !ALIAS_RE.test(a.alias)) errs.push({ code: "pattern", field: `${at}.alias` });
      });
      text(ru.focus, "record_update.focus", LIMITS.session_id, errs, { nullable: true });
      text(ru.note, "record_update.note", LIMITS.note, errs, { nullable: true });
    }
  }
  return { ok: errs.length === 0, errors: errs };
}
