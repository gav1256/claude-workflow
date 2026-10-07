// Brief checks: secret scan, worker-rules quote, brief parsing (spec:108-136, 340-355).

export const SECRET_PATTERNS = {
  sk: /\bsk-(ant-)?[A-Za-z0-9_-]{8,}/,
  gh: /\bgh[pous]_[A-Za-z0-9]{20,}/,
  akia: /\bAKIA[0-9A-Z]{16}\b/,
  pem: /-----BEGIN/,
  authjson: /auth\.json/,
};

export const WORKER_ONLY =
  "If you were dispatched as a worker (a subagent, or a Codex run given a task brief), follow only `## Worker rules` and the brief; ignore the rest of this file.";

export const FALLBACK_RULES = [
  "- Stay inside the files you own; create or edit nothing else.",
  "- No git commit, push, merge or branch switch; the controller commits.",
  "- No network access unless the brief grants it.",
  "- Write the failing test first when the task adds behaviour.",
  "- Keep the diff minimal; no drive-by refactors.",
  "- Check claims against the code at path:line; do not recall them.",
  "- Report honestly: a check you could not run is \"blocked\", not \"done\"; a check that only cannot run in the sandbox (Windows process/CIM/window tests) is no reason to block: finish the code, set status done, and name it as unverified.",
  "- Never read, print or copy credential files; use fake data (...@example.com).",
  "- Do not start subagents or other sessions.",
  "- Your final message is the report: status, files changed, checks run with real output.",
].join("\n");

const PLACEHOLDER = /^Worker rules: \{\{WORKER_RULES\}\}[ \t]*$/m;
const MAX_LINES = 80;

export function secretScan(text) {
  const s = String(text);
  return Object.entries(SECRET_PATTERNS)
    .filter(([, re]) => re.test(s))
    .map(([name]) => name);
}

// Host output is untrusted brief content: redact every match using the brief scan's own patterns, including commands.
// A pem or authjson hit means a key body or token dump may follow the marker, so that check's WHOLE output is withheld.
// A tail cut to TAIL_CHARS starts mid-line: its first partial line is dropped first (a cut token loses its sk-/ghp_ prefix).
const TAIL_CHARS = 3000;
const WITHHOLD = ["pem", "authjson"];

export function withholdMatches(text) {
  return WITHHOLD.filter((n) => SECRET_PATTERNS[n].test(text) || (n === "pem" && /-----END/.test(text)));
}

function feedbackOutput(tail, withhold) {
  const full = String(tail ?? "");
  const hit = withholdMatches(full);
  if (hit.length) return `[redacted: output withheld, matched ${hit.join(", ")}]`;
  if (withhold) return "[redacted: output withheld]";
  if (full.length < TAIL_CHARS) return full;
  const cut = full.slice(-TAIL_CHARS);
  const nl = cut.indexOf("\n");
  return nl < 0 ? "[output cut to a partial line: dropped]" : cut.slice(nl + 1);
}

export function checkFeedback(checks) {
  const failing = checks.filter((c) => c.timeout || c.exit !== 0);
  let text = "\n\n## Check results from the host\n" + failing.map((c) =>
    `\nCommand: ${c.cmd}\nResult: ${c.timeout ? "check-timeout" : `check-failed (exit ${c.exit})`}\nOutput:\n${feedbackOutput(c.tail, c.withhold)}\n`
  ).join("");
  for (const re of Object.values(SECRET_PATTERNS)) text = text.replace(new RegExp(re.source, "g"), "[redacted]");
  return text;
}

export function workerRules(agentsText) {
  const lines = String(agentsText ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => l === "## Worker rules");
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) { end = i; break; }
    }
    const body = lines.slice(start, end).join("\n").trim();
    // heading alone counts as empty
    if (lines.slice(start + 1, end).join("").trim() !== "") return { text: body, fallback: false };
  }
  return { text: FALLBACK_RULES, fallback: true };
}

export function finalizeBrief(text, agentsText) {
  const rules = workerRules(agentsText);
  const block = `Worker rules:\n${rules.text}`;
  let out = String(text).replace(/\r\n/g, "\n");
  if (PLACEHOLDER.test(out)) {
    out = out.replace(PLACEHOLDER, () => `${WORKER_ONLY}\n${block}`);
  } else {
    out = out.replace(/\n*$/, "\n") + `${WORKER_ONLY}\n${block}\n`;
  }
  return { text: out, workerRules: rules.fallback ? "fallback" : "agents" };
}

export function parseBrief(text, mode) {
  const s = String(text).replace(/\r\n/g, "\n");
  const trimmed = s.replace(/\n+$/, "");
  const lineCount = trimmed === "" ? 0 : trimmed.split("\n").length;
  if (lineCount > MAX_LINES) return { ok: false, reason: "brief-invalid: too long" };
  const m = /^Files you own:[ \t]*(.*)$/m.exec(s);
  if (!m) {
    if (mode === "write") return { ok: false, reason: "brief-invalid: no owned files" };
    return { ok: true, owned: [], task: s };
  }
  // The field may wrap: lines directly after the marker line (no blank line between) are
  // part of it, until a blank line, end of text, or a line that starts a new field
  // (`Read first:`, `Builds on:`, `Done when:`, `Constraints:`, ... or the template's
  // `Do not create or edit anything else.` line). Ordinary prose directly after the field
  // with no marker and no blank line is therefore read as owned-file tokens; keep a blank
  // line between the field and any prose.
  let field = m[1];
  for (const line of s.slice(m.index + m[0].length).split("\n").slice(1)) {
    if (line.trim() === "" || /^[A-Z][A-Za-z ]*:/.test(line) || /^Do not create/.test(line)) break;
    field += "\n" + line;
  }
  const owned = [];
  // a token is a backtick-quoted run (may hold spaces) or a run without commas/whitespace
  for (const t of field.matchAll(/`([^`]*)`\.?|[^,\s`]+/g)) {
    let tok = t[1] !== undefined ? t[1] : t[0];
    if (t[1] === undefined && tok.endsWith(".")) tok = tok.slice(0, -1);
    if (tok) owned.push(tok);
  }
  if (mode === "write" && owned.length === 0) return { ok: false, reason: "brief-invalid: no owned files" };
  return { ok: true, owned, task: s };
}
