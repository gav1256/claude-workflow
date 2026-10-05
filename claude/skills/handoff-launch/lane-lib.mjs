// Pure lane decisions of batch A (stages 3 and 4): launch provenance (`supersedes`, chains, the superseded relation, the
// restart guard), the occupancy check, priority, the write fence, the lane note and the inbox. No fs, no clock, no
// processes: callers pass registry entries, paths and `now` in (tests/lane-lib.test.mjs covers each decision).
import path from "node:path";
import crypto from "node:crypto";

export const MIN = 60000;

// ---------- paths: compared case-insensitively with forward slashes (as merge-lib key() does), no trailing slash ----------
// A long-path \\?\ prefix is stripped. Relative paths resolve against cwd.
export function normPath(p, cwd = null) {
  let s = String(p ?? "").replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  if (!s) return "";
  if (cwd && !path.isAbsolute(s)) s = path.resolve(String(cwd).replace(/^\\\\\?\\/, ""), s);
  return s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
export const isUnder = (p, root) => !!p && !!root && (p === root || p.startsWith(`${root}/`));
const ts = (e) => Date.parse(e?.launched_at) || 0;
const gen = (e) => e?.generation || 0;

// ---------- Part 1: launch provenance ----------
// A line WITHOUT the key is a legacy line (written before batch A).
export const hasSupersedesKey = (e) => !!e && Object.hasOwn(e, "supersedes");
// Same checkout: same worktree path, or same repo + branch.
export const sameCheckout = (a, b) => !!a && !!b && ((!!a.worktree && normPath(a.worktree) === normPath(b.worktree)) || (a.repo === b.repo && a.branch === b.branch));
// The entries N supersedes, nearest first. N with the key: S = N.supersedes, plus S's chain when S also has the key; a
// legacy entry reached through a link ends the chain (it is in the chain, its predecessors are not). Chains pass through
// closed entries. N legacy: every entry of the same repo + branch with a lower generation (the stage-2 rule).
export function chainOf(n, entries) {
  if (!n) return [];
  if (!hasSupersedesKey(n)) return entries.filter((x) => x.id !== n.id && x.repo === n.repo && x.branch === n.branch && gen(x) < gen(n));
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = [], seen = new Set([n.id]);
  let s = n.supersedes ? byId.get(n.supersedes) : null;
  while (s && !seen.has(s.id)) {
    out.push(s); seen.add(s.id);
    if (!hasSupersedesKey(s)) break;
    s = s.supersedes ? byId.get(s.supersedes) : null;
  }
  return out;
}
// O is superseded by N: N was launched after O and O is in N's chain. A legacy N's chain is the generation order, which
// already says "after" (its launch time may equal O's to the millisecond in hand-made lines); a link of a new N is
// written by a later launch, so the same millisecond still counts as after.
export const supersedes = (n, o, entries) => !!n && !!o && n.id !== o.id && (!hasSupersedesKey(n) || ts(n) >= ts(o))
  && chainOf(n, entries).some((x) => x.id === o.id);
// The open entries that supersede o (the tick's close candidates' successors).
export const supersedersOf = (o, entries, closed) => entries.filter((n) => !closed.has(n.id) && supersedes(n, o, entries));
// What a launch line's `supersedes` is (first match wins):
//   1. resumeOf: the entry a --resume resumes; 2. explicit: --supersedes <id>; 3. a relay: the launcher L (by
//   HL_SESSION_ID = L.id, else launched_by = L.session_id) runs in the target checkout; 4. a merge session with no known
//   launcher: the target checkout's newest open entry; 5. anything else: null.
// target: {repo, branch, worktree}. -> {supersedes, rule, launcher, note}
export function pickSupersedes({ entries, closed = new Set(), resumeOf = null, explicit = null, hlSessionId = null, launchedBy = null, target, name, isMerge = false }) {
  if (resumeOf) return { supersedes: resumeOf.id, rule: "resume", launcher: null, note: null };
  if (explicit) return { supersedes: explicit, rule: "explicit", launcher: null, note: null };
  const newest = (f) => [...entries].reverse().find(f) ?? null;
  const L = (hlSessionId && newest((e) => e.id === hlSessionId)) || (launchedBy && newest((e) => e.session_id === launchedBy)) || null;
  if (L && sameCheckout(L, target))
    return { supersedes: L.id, rule: "relay", launcher: L, note: L.name !== name ? `note: this launch replaces ${L.name} (gen ${L.generation ?? "?"}) as its relay` : null };
  if (isMerge && !L) {
    const prev = newest((e) => !closed.has(e.id) && e.repo === target.repo && e.branch === target.branch);
    return { supersedes: prev?.id ?? null, rule: "merge", launcher: null, note: null };
  }
  return { supersedes: null, rule: "none", launcher: L, note: null };
}

// ---------- the occupancy check (rule-5 launches; gone windows are closed for every fresh launch) ----------
// One open entry on the target checkout. lv: its liveness {state, why}; below: hostBelow()'s answer for a window
// ({claude, empty, names}, null = the probe failed); ageMs: since its launch. -> {act: ignore|warn|close|refuse, why}
export function occupantAct({ e, lv, below, ageMs }) {
  if (lv.state === "gone") return { act: "ignore", why: lv.why };
  if (lv.state === "unknown") return { act: "warn", why: lv.why };
  if (e.mode === "bg") return { act: "refuse", why: "claude agents lists it as running" };
  if (!below) return { act: "warn", why: "the process probe below its window failed" };
  // An empty host (nothing below it but conhost): claude exited or never started. Within 2 min of the launch it may still
  // be starting, so it counts as running.
  if (below.empty) return ageMs >= 2 * MIN ? { act: "close", why: "claude exited (its window host is empty)" } : { act: "refuse", why: "its window is still starting" };
  return { act: "refuse", why: below.claude ? "claude runs in its window" : `its window runs ${below.names.join(", ")}` };
}
export const OCCUPIED = ({ repo, branch, e }) => `refused - ${repo}@${branch} already has a running session ${e.name} (gen ${e.generation ?? "?"}, id ${e.id}): `
  + "two sessions must not share a worktree. Launch a helper with --worktree <own branch>, or replace that session explicitly with "
  + `--supersedes ${e.id}. --force overrides (ask the user first).`;
export const OCCUPANT_UNKNOWN = ({ repo, branch, e, why }) => `warning: ${repo}@${branch} has an open session ${e.name} (gen ${e.generation ?? "?"}, id ${e.id}) whose liveness is unknown (${why}) - two sessions must not share a worktree: check it`;

// ---------- the restart guard (the union: the conservative direction) ----------
// Open entries that block a restart of e: newer on the same repo + branch, or with e in their chain.
export function restartBlockers(e, entries, closed = new Set()) {
  return entries.filter((x) => x.id !== e.id && !closed.has(x.id)
    && ((x.repo === e.repo && x.branch === e.branch && gen(x) > gen(e)) || supersedes(x, e, entries)));
}
// A blocker that is not e's successor is a co-tenant (a --force'd launch on e's checkout).
export const isSuccessor = (x, e, entries) => supersedes(x, e, entries);

// ---------- Part 7: priority ----------
export const PRIORITIES = ["high", "normal", "low"];
const RANK = { high: 0, normal: 1, low: 2 };
// From the sizing: model fable, or effort xhigh or max -> high; effort high -> normal; medium or low -> low; neither -> normal.
export function derivePriority({ model, effort } = {}) {
  if (/fable/i.test(String(model ?? "")) || effort === "xhigh" || effort === "max") return "high";
  if (effort === "medium" || effort === "low") return "low";
  return "normal";
}
// The latest of the newest launch line e of its name and any later {priority: <name>, group, value, at} line.
export function effectivePriority(lines, e) {
  if (!e) return "normal";
  let p = PRIORITIES.includes(e.priority) ? e.priority : derivePriority(e);
  const t = ts(e);
  for (const o of lines || []) {
    if (o && !o.launched_at && o.priority === e.name && PRIORITIES.includes(o.value) && (o.group ?? null) === (e.group ?? null) && (Date.parse(o.at) || 0) >= t) p = o.value;
  }
  return p;
}
export const priorityRank = (p) => RANK[p] ?? RANK.normal;
// The one shared sort: priority first, then `then` (default: the input order; Array.prototype.sort is stable).
export function byPriority(items, prio, then = () => 0) {
  return [...items].sort((a, b) => priorityRank(prio(a)) - priorityRank(prio(b)) || then(a, b));
}

// ---------- Part 4: the write fence ----------
// e: the session's own launch line; mainRoot: its main checkout root (e.repo is its key). -> the own root, normalised.
// The entry's worktree when it is under <main>/.claude/worktrees/ or outside the main checkout; else the main checkout.
export function ownRoot(e) {
  const main = normPath(e.repo), wt = normPath(e.worktree || e.repo);
  if (isUnder(wt, `${main}/.claude/worktrees`) || !isUnder(wt, main)) return wt;
  return main;
}
// The main checkout's open session for the denial text: the newest of `others` whose own root is the main checkout.
export const mainSessionOf = (others, main) => [...(others || [])].filter((o) => ownRoot(o) === normPath(main)).sort((a, b) => ts(a) - ts(b)).at(-1) ?? null;
// p: the tool's file path; ctx: {cwd, own, main, config, tmp, others: [launch lines] (the other open entries of the same
// repo, own excluded)}. -> {allow: true} | {allow: false, owner: {name, branch} | null, mainCheckout}
export function fenceDecision(p, ctx) {
  const P = normPath(p, ctx.cwd);
  if (!P) return { allow: true };
  const main = normPath(ctx.main), wts = `${main}/.claude/worktrees`;
  // Each other entry owns its own root; an entry on the main checkout owns no worktree (the main checkout is judged below).
  const others = (ctx.others || []).map((o) => ({ ...o, root: ownRoot(o) })).filter((o) => o.root && o.root !== main);
  const owner = others.filter((o) => isUnder(P, o.root)).sort((a, b) => b.root.length - a.root.length)[0] || null;
  const own = normPath(ctx.own);
  const inMainCheckout = (q) => isUnder(q, main) && !isUnder(q, wts);
  // 1. Own root (the main checkout means main minus .claude/worktrees/**); a deeper lane's worktree inside it is not own.
  const underOwn = own === main ? inMainCheckout(P) : isUnder(P, own);
  if (underOwn && !(owner && owner.root.length > own.length)) return { allow: true };
  // 2. Config, temp, <main>/.superpowers, an unowned <main>/.claude/worktrees/<x>.
  if ([ctx.config, ctx.tmp, `${main}/.superpowers`].some((r) => r && isUnder(P, normPath(r)))) return { allow: true };
  if (isUnder(P, wts) && !owner) return { allow: true };
  // 3. Another open entry's worktree of this repo, wherever it lives; the main checkout for a session not on it.
  if (owner) return { allow: false, owner, mainCheckout: false };
  if (own !== main && inMainCheckout(P)) {
    const s = mainSessionOf(ctx.others, main);
    return { allow: false, owner: s ? { name: s.name, branch: s.branch } : null, mainCheckout: true };
  }
  // 4. Everything else: other repos, files outside any checkout.
  return { allow: true };
}
export function fenceText({ p, own, owner, mainCheckout, launchMjs, ownName }) {
  const q = `node ${launchMjs} queue`;
  if (mainCheckout && !owner) return `Write fence: ${p} belongs to the main checkout (no session): tell the user, or queue it --after-merge in your group `
    + `(${q} --to ${ownName} --after-merge --text "<what to change>"). It does not belong to this lane (${own}): do not edit it from here.`;
  const who = mainCheckout ? `the main checkout (lane ${owner.name}, ${owner.branch})` : `lane ${owner.name} (${owner.branch})`;
  return `Write fence: ${p} belongs to ${who}, not to this lane (${own}). Do not edit it from here. `
    + `Queue the change: ${q} --to ${owner.name} --text "<what to change>" [--after-merge], or tell the user.`;
}

// ---------- Part 5: the lane note ----------
// me: {name, branch, own, priority}; others: [{name, branch, scope}]
export function laneNoteText(me, others) {
  const list = others.length ? `Other live lanes in this repo: ${others.map((o) => `${o.name} (${o.branch}${o.scope ? `, ${o.scope}` : ""})`).join("; ")}.`
    : "No other live lanes in this repo.";
  return `Lane note: you are lane ${me.name} (branch ${me.branch}, ${me.own}, priority ${me.priority}). ${list}`
    + (others.length ? " A request meant for another lane: say it belongs to that lane and offer launch.mjs queue --to <lane>. Work on files another live lane is changing: queue it with --after-merge." : "");
}
export const textHash = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
// lanes.json lanes (or the registry fallback) of one repo minus the session's own lane (same id, or same repo + branch).
export const otherLanes = (lanes, me) => (lanes || []).filter((l) => l && l.id !== me.id && !(l.branch === me.branch && normPath(l.worktree) === normPath(me.worktree)));
// The registry fallback: open entries of repo, newest per lane (repo + branch), no liveness filter.
export function openLanes(entries, closed, repo) {
  const m = new Map();
  for (const e of entries) if (e.repo === repo && !closed.has(e.id)) { const k = e.branch; if (!m.has(k) || ts(m.get(k)) <= ts(e)) m.set(k, e); }
  return [...m.values()];
}

// ---------- Part 1: the scope of a launch ----------
// The handoff's first `# ` heading, trimmed to 80 characters; null without one.
export function scopeOf(text) {
  const m = /^# +(.+?)\s*$/m.exec(String(text ?? ""));
  return m ? m[1].slice(0, 80) : null;
}

// ---------- Part 6: the inbox ----------
export const inboxBlock = (at, from, text) => `## ${at} from ${from}\n\n${String(text).trim()}\n\n`;
export const inboxItems = (text) => (String(text ?? "").match(/^## \d{4}-\d\d-\d\dT\S+ from .*$/gm) || []).length;
export const INBOX_SENTENCE = (p) => ` Read your inbox first: ${p} - items other lanes queued for you.`;
export const takenName = (lane, stamp) => `${lane}.${stamp}.taken.md`;
