import { validateShape } from "./schema.mjs";
export const FINISHED = new Set(["finished", "dead"]);
export const MESSAGEABLE = new Set(["starting", "running", "idle", "waiting_for_user", "queued", "blocked", "failed", "unknown"]);
const DISPATCHING = new Set(["message_session", "message_multiple", "create_session"]);
export const lowConfidence = (d, min) => DISPATCHING.has(d.action) && d.confidence < min;

export function validateDecision(d, { workers }) {
  const shape = validateShape(d);
  if (!shape.ok) return shape;
  const errs = [], byId = new Map(workers.map((w) => [w.id, w])), t = d.target_session_ids, ns = d.new_session;
  const need = (ok, code, field, detail) => { if (!ok) errs.push({ code, field, ...(detail !== undefined ? { detail } : {}) }); };
  const messageable = (id, i) => {
    const w = byId.get(id), field = `target_session_ids.${i}`;
    if (!w) return need(false, "unknown-target", field, id);
    need(MESSAGEABLE.has(w.status), "target-not-messageable", field, `${id} is ${w.status}`);
  };
  const noTargets = () => need(t.length === 0, "targets-not-allowed", "target_session_ids");
  const noInstruction = () => need(d.worker_instruction === null, "instruction-not-allowed", "worker_instruction");
  const noNew = () => need(ns.needed === false, "new-session-not-allowed", "new_session.needed");
  switch (d.action) {
    case "respond": noTargets(); noInstruction(); noNew(); break;
    case "message_session":
    case "message_multiple":
      need(d.action === "message_session" ? t.length === 1 : t.length >= 2, "target-count", "target_session_ids", String(t.length));
      t.forEach(messageable);
      need(!!d.worker_instruction && !!d.worker_instruction.trim(), "instruction-required", "worker_instruction");
      noNew(); break;
    case "create_session":
      noTargets();
      need(ns.needed === true, "new-session-required", "new_session.needed");
      need(!!ns.label, "label-required", "new_session.label");
      need(!!ns.objective && !!ns.objective.trim(), "objective-required", "new_session.objective");
      need(![...byId.values()].some((w) => w.label === ns.label && !FINISHED.has(w.status)), "label-in-use", "new_session.label", ns.label);
      break;
    case "request_status": t.forEach((id, i) => need(byId.has(id), "unknown-target", `target_session_ids.${i}`, id)); noInstruction(); noNew(); break;
    case "clarify": noTargets(); noInstruction(); noNew(); need(!!d.clarification && !!d.clarification.trim(), "clarification-required", "clarification"); break;
  }
  if (d.record_update) {
    d.record_update.aliases.forEach((a, i) => {
      need(byId.has(a.session_id), "unknown-target", `record_update.aliases.${i}.session_id`, a.session_id);
      const clash = [...byId.values()].find((w) => w.id !== a.session_id && (w.id === a.alias || w.label === a.alias || (w.aliases ?? []).includes(a.alias)));
      need(!clash, "alias-clash", `record_update.aliases.${i}.alias`, clash?.id);
    });
    if (d.record_update.focus !== null) need(byId.has(d.record_update.focus), "unknown-target", "record_update.focus", d.record_update.focus);
  }
  return { ok: errs.length === 0, errors: errs };
}
