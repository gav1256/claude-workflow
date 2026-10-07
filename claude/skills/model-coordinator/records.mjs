// coordinator_records.md: a pure renderer. It takes no path; store.writeRecords is the only writer.
// Everything that came from a model or a worker is flattened into single bullet lines so it cannot add a heading.

const MAX_BYTES = 16384;
const FINISHED = new Set(["finished", "dead"]);

/** One line of safe text: control characters and newlines become spaces, leading # and list markers go, capped. */
function clean(v, n = 300) {
  let s = String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^[#>\-*+\s]+/, "");
  return s.slice(0, n);
}
const noteText = (n) => (n && typeof n === "object" ? n.note : n);

function relationships(list) {
  const out = [];
  for (const w of list) {
    if (w.in_worktree_of) out.push(`- ${clean(w.id, 80)} works in ${clean(w.in_worktree_of, 80)}'s worktree`);
    if (w.fallback_of) out.push(`- ${clean(w.id, 80)} replaced a Codex request (fallback: ${clean(w.fallback_reason ?? "unknown", 200)})`);
  }
  return out.length ? out : ["- (none)"];
}

function build(list, focus, notes) {
  const L = ["# Coordinator records", "", "## Workers", ""];
  if (!list.length) L.push("- (none)");
  for (const w of list) {
    const bl = (w.blockers ?? []).slice(0, 3).map((b) => clean(b, 200)).filter(Boolean);
    const parts = [`- ${clean(w.id, 80)} (${clean(w.provider, 20)}, ${clean(w.status, 30)}): ${clean(w.objective, 200)}`];
    if (w.last_result) parts.push(`last: ${clean(w.last_result, 200)}`);
    if (bl.length) parts.push(`blockers: ${bl.join("; ")}`);
    if (w.needs_user) parts.push(`needs you: ${clean(typeof w.needs_user === "string" ? w.needs_user : "yes", 200)}`);
    L.push(parts.join(" | "));
  }
  L.push("", "## Focus", "", focus ? `- ${clean(focus, 80)}` : "- (none)", "", "## Aliases", "");
  const al = list.flatMap((w) => (w.aliases ?? []).map((a) => `- ${clean(a, 40)} -> ${clean(w.id, 80)}`));
  L.push(...(al.length ? al : ["- (none)"]));
  L.push("", "## Notes", "");
  L.push(...(notes.length ? notes.map((n) => `- ${n}`) : ["- (none)"]));
  L.push("", "## Task relationships", "", ...relationships(list), "");
  return L.join("\n");
}

/**
 * @param {{workers: Map<string, object>|object[], focus: string|null, notes: Array<string|{note: string}>}} p
 * @returns {string} Markdown, at most 16 KiB. Notes: the last 20, each flattened, without a leading #, 300 characters.
 */
export function renderRecords({ workers, focus = null, notes = [] } = {}) {
  let list = workers instanceof Map ? [...workers.values()] : Array.isArray(workers) ? [...workers] : [];
  let ns = (notes ?? []).map((n) => clean(noteText(n), 300)).filter(Boolean).slice(-20);
  let out = build(list, focus, ns);
  // Over budget: drop the oldest notes first, then the oldest finished workers, then the oldest of the rest.
  while (Buffer.byteLength(out) > MAX_BYTES && ns.length) { ns = ns.slice(1); out = build(list, focus, ns); }
  while (Buffer.byteLength(out) > MAX_BYTES && list.length) {
    const i = list.findIndex((w) => FINISHED.has(w.status));
    list = list.filter((_, j) => j !== (i >= 0 ? i : 0));
    out = build(list, focus, ns);
  }
  return out;
}
