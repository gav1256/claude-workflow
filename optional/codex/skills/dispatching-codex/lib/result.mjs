// The one JSON line Claude reads: at most 2000 chars, truncated in a fixed order (plan Task 8).
// review results carry `patch_sha256` (A15), passed through untouched.
const MAX = 2000;

const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "~" : s);
const size = (o) => JSON.stringify(o).length;

function capFields(list, n) {
  return list.map((it) => {
    if (typeof it === "string") return cut(it, n);
    if (!it || typeof it !== "object") return it;
    const o = {};
    for (const [k, v] of Object.entries(it)) o[k] = cut(v, n);
    return o;
  });
}

export function buildResult(r) {
  const o = { ...r };
  const tails = (n) => {
    if (Array.isArray(o.checks)) o.checks = o.checks.map((c) => (c && typeof c === "object" ? { ...c, tail: cut(c.tail, n) } : c));
  };
  tails(300);
  if (o.codex_note !== undefined) o.codex_note = cut(o.codex_note, 300);
  if (Array.isArray(o.findings)) {
    // upstream review findings (severity/title/body/...) shrink to {severity, title, file, line_start, line_end};
    // other shapes (research: claim/source_url/confidence) keep every field, each cut to 200 chars
    const review = (f) => f && typeof f === "object" && typeof f.severity === "string" && typeof f.title === "string";
    o.findings = o.findings.slice(0, 8).map((f) =>
      review(f)
        ? { severity: f.severity, title: cut(f.title, 100), file: cut(f.file, 200), line_start: f.line_start, line_end: f.line_end }
        : capFields([f], 200)[0]);
  }
  if (Array.isArray(o.hypotheses)) o.hypotheses = capFields(o.hypotheses.slice(0, 5), 200);
  if (o.answer !== undefined) o.answer = cut(o.answer, 1500);
  if (o.summary !== undefined) o.summary = cut(o.summary, 300);
  if (size(o) > MAX && Array.isArray(o.files)) {
    const all = o.files;
    let n = all.length;
    while (n > 0 && size(o) > MAX) {
      n--;
      o.files = [...all.slice(0, n), `+${all.length - n} more`];
    }
  }
  if (size(o) > MAX) tails(80);
  // Last resorts so the line always fits: shrink free text, then drop trailing list items.
  if (size(o) > MAX) {
    if (o.answer !== undefined) o.answer = cut(o.answer, 500);
    if (o.codex_note !== undefined) o.codex_note = cut(o.codex_note, 100);
    if (o.reason !== undefined) o.reason = cut(o.reason, 200);
  }
  for (const k of ["findings", "hypotheses"]) {
    while (size(o) > MAX && Array.isArray(o[k]) && o[k].length) o[k] = o[k].slice(0, -1);
  }
  return JSON.stringify(o);
}
