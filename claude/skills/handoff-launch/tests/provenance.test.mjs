// Batch A, Part 1 and the smaller launcher changes: launch provenance (launched_by, supersedes, scope, priority), the
// occupancy check, the environment scrub, unknown flags, --resume's --profile and the union restart guard.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sandbox, sessionLine, appendLine, launchLane, commitIn, writeDone, host, emptyHost, jobHost, hasPython, alive, LAUNCH } from "./helpers.mjs";

const win = process.platform !== "win32";
// A launch with extra env (a launcher session's HL_SESSION_ID / CLAUDE_CODE_SESSION_ID).
const runEnv = (sb, env, ...a) => {
  const r = spawnSync(process.execPath, [LAUNCH, ...a], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 180000 });
  return { code: r.status, out: (r.stdout || "").replace(/\r/g, ""), err: (r.stderr || "").replace(/\r/g, "") };
};
const base = (name) => ["--repo", null, "--handoff", null, "--name", name, "--model", "opus", "--effort", "high"];
const launch = (sb, name, ...extra) => sb.run(...base(name).map((x, i) => (i === 1 ? sb.repo : i === 3 ? sb.handoff : x)), ...extra);
const launchEnv = (sb, env, name, ...extra) => runEnv(sb, env, ...base(name).map((x, i) => (i === 1 ? sb.repo : i === 3 ? sb.handoff : x)), ...extra);
const lastLaunch = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name).at(-1);
const wtOf = (sb, b) => path.join(sb.repo, ".claude", "worktrees", b).split(path.sep).join("/");

test("launch lines record launched_by, supersedes, scope and priority; a plain-terminal launch replaces nothing", () => {
  const sb = sandbox();
  try {
    fs.writeFileSync(sb.handoff, "intro\n# Stage 3: lane hygiene\n");
    assert.equal(launch(sb, "A", "--worktree", "lane-a").code, 0);
    const a = lastLaunch(sb, "A");
    assert.ok(Object.hasOwn(a, "supersedes"));
    assert.deepEqual([a.launched_by, a.supersedes, a.scope, a.priority], [null, null, "Stage 3: lane hygiene", "normal"]);
    let r = runEnv(sb, {}, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "B", "--model", "fable", "--effort", "high", "--worktree", "lane-b", "--scope", "my own scope");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([lastLaunch(sb, "B").priority, lastLaunch(sb, "B").scope], ["high", "my own scope"]);
    assert.equal(runEnv(sb, {}, "--repo", sb.repo, "--handoff", sb.handoff, "--name", "C", "--model", "opus", "--effort", "medium", "--worktree", "lane-c").code, 0);
    assert.equal(lastLaunch(sb, "C").priority, "low");
    assert.equal(launch(sb, "D", "--worktree", "lane-d", "--priority", "low").code, 0);
    assert.equal(lastLaunch(sb, "D").priority, "low");
    r = launch(sb, "E", "--worktree", "lane-e", "--priority", "urgent");
    assert.equal(r.code, 2); assert.match(r.err, /--priority must be high, normal or low, got urgent/);
  } finally { sb.cleanup(); }
});

test("a relay supersedes its launcher (by HL_SESSION_ID, else CLAUDE_CODE_SESSION_ID); a launcher elsewhere replaces nothing", () => {
  const sb = sandbox();
  try {
    assert.equal(launch(sb, "A", "--worktree", "lane-a").code, 0);
    const a = lastLaunch(sb, "A");
    let r = launchEnv(sb, { HL_SESSION_ID: a.id, CLAUDE_CODE_SESSION_ID: "s-launcher" }, "A", "--worktree", "lane-a");
    assert.equal(r.code, 0, r.err);
    const a2 = lastLaunch(sb, "A");
    assert.deepEqual([a2.supersedes, a2.launched_by], [a.id, "s-launcher"]);
    assert.doesNotMatch(r.err, /as its relay/); // same name: no note
    // Found by launched_by alone (a launcher session without HL_SESSION_ID), under another name: the note says so.
    r = launchEnv(sb, { CLAUDE_CODE_SESSION_ID: a2.session_id }, "A-next", "--worktree", "lane-a");
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLaunch(sb, "A-next").supersedes, a2.id);
    assert.match(r.err, /^note: this launch replaces A \(gen 2\) as its relay$/m);
    // A registry session launching onto another checkout: no relay.
    r = launchEnv(sb, { HL_SESSION_ID: a.id }, "K", "--worktree", "lane-k");
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLaunch(sb, "K").supersedes, null);
  } finally { sb.cleanup(); }
});

test("--supersedes names the entry a launch replaces; an id with no launch line exits 2 before any side effect", () => {
  const sb = sandbox();
  try {
    assert.equal(launch(sb, "A", "--worktree", "lane-a").code, 0);
    const a = lastLaunch(sb, "A"), n = sb.registry().length;
    let r = launch(sb, "B", "--worktree", "lane-a", "--supersedes", "nobody@1");
    assert.equal(r.code, 2); assert.match(r.err, /--supersedes: no launch line has id nobody@1/);
    assert.equal(sb.registry().length, n);
    r = launch(sb, "B", "--worktree", "lane-a", "--supersedes");
    assert.equal(r.code, 2);
    r = launch(sb, "B", "--worktree", "lane-a", "--supersedes", a.id);
    assert.equal(r.code, 0, r.err);
    assert.equal(lastLaunch(sb, "B").supersedes, a.id);
  } finally { sb.cleanup(); }
});

test("--scope needs a text: a missing value, an empty one or a --flag in its place exits 2 before any side effect", () => {
  const sb = sandbox();
  try {
    for (const extra of [["--scope"], ["--scope", "--dry-run"], ["--scope", ""]]) {
      const r = launch(sb, "A", "--worktree", "lane-a", ...extra);
      assert.equal(r.code, 2, `${extra.join(" ")}: ${r.err}${r.out}`); assert.match(r.err, /^--scope needs a text: --scope "<text>"$/m);
    }
    assert.equal(sb.registry().length, 0);
    assert.equal(fs.existsSync(wtOf(sb, "lane-a")), false);
  } finally { sb.cleanup(); }
});

test("--worktree <the main checkout's branch> is the usage error (exit 2) before the occupancy check: nothing refused as occupied, nothing closed", { skip: win }, () => {
  const sb = sandbox();
  const hosts = [emptyHost(), host()];
  try {
    const usage = /^branch main is checked out in the main checkout .* - drop --worktree or pick another branch$/m;
    const regFile = path.join(sb.reg, "sessions.jsonl");
    // A window on the main checkout whose claude exited: the occupancy pass would close it - the usage error comes first.
    sessionLine(sb, { name: "E", id: "E@1", branch: "main", sid: "e-s1", host: hosts[0], supersedes: null });
    let before = fs.readFileSync(regFile);
    let r = launch(sb, "Y", "--worktree", "main");
    assert.equal(r.code, 2, r.err + r.out); assert.match(r.err, usage); assert.doesNotMatch(r.err, /closed E/);
    assert.ok(fs.readFileSync(regFile).equals(before)); assert.equal(alive(hosts[0].pid), true);
    // A running session on the main checkout: the occupancy pass would refuse with exit 3 - the usage error comes first.
    sessionLine(sb, { name: "M", id: "M@1", branch: "main", sid: "m-s1", host: hosts[1], supersedes: null });
    before = fs.readFileSync(regFile);
    r = launch(sb, "Y", "--worktree", "main");
    assert.equal(r.code, 2, r.err + r.out); assert.match(r.err, usage); assert.doesNotMatch(r.err, /already has a running session/);
    assert.ok(fs.readFileSync(regFile).equals(before)); assert.equal(alive(hosts[1].pid), true);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("occupancy: a launch that replaces nothing onto a running session's checkout is refused (exit 3) before any side effect", { skip: win }, () => {
  const sb = sandbox();
  const h = host();
  try {
    const x = sessionLine(sb, { name: "X", id: "X@1", branch: "lane-x", worktree: wtOf(sb, "lane-x"), sid: "x-s1", host: h, supersedes: null });
    const before = fs.readFileSync(path.join(sb.reg, "sessions.jsonl"));
    let r = launch(sb, "Y", "--worktree", "lane-x");
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /^refused - .*@lane-x already has a running session X \(gen 1, id X@1\): two sessions must not share a worktree\. Launch a helper with --worktree <own branch>, or replace that session explicitly with --supersedes X@1\. --force overrides \(ask the user first\)\.$/m);
    assert.ok(fs.readFileSync(path.join(sb.reg, "sessions.jsonl")).equals(before));
    assert.equal(fs.existsSync(wtOf(sb, "lane-x")), false);
    r = launch(sb, "Y", "--worktree", "lane-x", "--dry-run"); // prints the decision, refuses nothing
    assert.equal(r.code, 0, r.err); assert.match(r.err, /^would be refused - /m);
    assert.equal(JSON.parse(r.out).occupancy.refused, "X@1");
    // A relay of X itself, and an explicit replacement, never reach the refusal.
    r = launchEnv(sb, { HL_SESSION_ID: "X@1" }, "X", "--worktree", "lane-x");
    assert.equal(r.code, 0, r.err); assert.equal(lastLaunch(sb, "X").supersedes, "X@1");
    r = launch(sb, "Z", "--worktree", "lane-x", "--supersedes", "X@1");
    assert.equal(r.code, 0, r.err);
    assert.equal(alive(h.pid), true); // nothing closed it
    r = launch(sb, "W", "--worktree", "lane-x", "--force");
    assert.equal(r.code, 0, r.err); assert.match(r.err, /^occupancy overridden by --force: refused - /m);
  } finally { h.kill(); sb.cleanup(); }
});

test("occupancy: a window whose claude exited (empty host) is closed first; a user's job below the host keeps it; unknown only warns", { skip: win }, () => {
  const sb = sandbox();
  const hosts = [emptyHost(), ...(hasPython() ? [jobHost()] : [])];
  try {
    const d = sessionLine(sb, { name: "D", id: "D@1", branch: "lane-d", worktree: wtOf(sb, "lane-d"), sid: "d-s1", host: hosts[0], supersedes: null });
    let r = launch(sb, "D2", "--worktree", "lane-d");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.err, /^closed D \(gen 1\): claude exited \(closed before this launch\)$/m);
    assert.equal(alive(hosts[0].pid), false);
    assert.ok(sb.registry().some((o) => o.kill_intent === d.id && o.kind === "close") && sb.registry().some((o) => o.closed && o.id === d.id));
    if (hosts[1]) { // host + python child: the window is the user's now - kept, and it counts as running
      sessionLine(sb, { name: "J", id: "J@1", branch: "lane-j", worktree: wtOf(sb, "lane-j"), sid: "j-s1", host: hosts[1], supersedes: null });
      r = launch(sb, "J2", "--worktree", "lane-j");
      assert.equal(r.code, 3, r.err + r.out); assert.match(r.err, /already has a running session J /);
      assert.equal(alive(hosts[1].pid), true);
    }
    sessionLine(sb, { name: "U", id: "U@1", branch: "lane-u", worktree: wtOf(sb, "lane-u"), sid: "u-s1", host: { pid: 4242, start: new Date().toISOString() }, supersedes: null });
    r = runEnv(sb, { HL_FAKE_PROBE: "fail" }, ...base("U2").map((x, i) => (i === 1 ? sb.repo : i === 3 ? sb.handoff : x)), "--worktree", "lane-u");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.err, /^warning: .*@lane-u has an open session U \(gen 1, id U@1\) whose liveness is unknown \(process probe failed/m);
  } finally { for (const h of hosts) h.kill(); sb.cleanup(); }
});

test("an unknown flag warns and is ignored; the known set is exactly the opt/flag/val literals of launch.mjs", () => {
  const sb = sandbox();
  try {
    const r = launch(sb, "A", "--priorty", "high", "--reopen");
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /^warning: unknown flag --priorty \(ignored\)$/m);
    assert.doesNotMatch(r.err, /unknown flag --reopen/);
    const src = fs.readFileSync(LAUNCH, "utf8");
    const used = new Set([...src.matchAll(/\b(?:opt|flag|val)\("([a-z-]+)"/g)].map((m) => m[1]));
    const known = new Set([.../const KNOWN_FLAGS = new Set\(\[([^\]]*)\]\)/.exec(src)[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...known].sort(), [...used].sort());
    assert.ok(known.has("reopen"));
  } finally { sb.cleanup(); }
});

test("--resume: --profile picks a new profile; provenance and priority are explicit; the restart guard is the union", () => {
  const sb = sandbox();
  try {
    const a = sessionLine(sb, { name: "A", sid: "s-1", profile: "python", model: "fable", effort: "xhigh", supersedes: null, scope: "Stage A" });
    let r = runEnv(sb, { CLAUDE_CODE_SESSION_ID: "s-hand" }, "--resume", "s-1", "--profile", "browser");
    assert.equal(r.code, 0, r.err);
    const n = lastLaunch(sb, "A");
    assert.deepEqual([n.profile, n.supersedes, n.launched_by, n.priority, n.scope, n.resumed_from], ["browser", a.id, "s-hand", "high", "Stage A", a.id]);
    // A relay of the resumed entry on a switched branch (same name check passes: another name) blocks a second resume.
    const b = sessionLine(sb, { name: "B", id: "B@1", sid: "s-b", branch: "b1", supersedes: null });
    sessionLine(sb, { name: "B-next", id: "B@2", sid: "s-b2", branch: "b2", supersedes: "B@1", launched_at: new Date(Date.parse(b.launched_at) + 1000).toISOString() });
    r = sb.run("--resume", "s-b");
    assert.equal(r.code, 3, r.err + r.out);
    assert.match(r.err, /--resume: an open newer launch shares the checkout of B \(B@2\)/);
    r = sb.run("--resume", "s-b", "--priority", "low", "--dry-run");
    assert.equal(r.code, 3);
  } finally { sb.cleanup(); }
});

test("a merge session launched by a lane's drain gets the scrubbed env: no launcher, so it replaces the merge worktree's previous session", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run("group", "--group", "g1", "--repo", sb.repo, "--integration", "int-g1", "--target", "main", "--test", "node check.cjs").code, 0);
    const d = launchLane(sb, "g1", "D"), dl = lastLaunch(sb, "D");
    const scratch = path.join(sb.repo, ".claude", "worktrees", "_merge-g1").split(path.sep).join("/");
    const prev = sessionLine(sb, { name: "g1-merge-X", id: "g1-merge-X@1", group: "g1", branch: "int-g1", worktree: scratch, sid: "s-mx", supersedes: null });
    writeDone(sb, "g1", "D", commitIn(sb, d, { FAIL: "x\n" }, "D adds FAIL"));
    // The lane runs the merge from its own session: its identity is in the env.
    const r = runEnv(sb, { HL_SESSION_ID: dl.id, CLAUDE_CODE_SESSION_ID: "s-lane-d" }, "merge", "--group", "g1", "--repo", sb.repo, "--lane", "D");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /merge session g1-merge-D launched/);
    const m = lastLaunch(sb, "g1-merge-D");
    assert.deepEqual([m.launched_by, m.supersedes], [null, prev.id]);
  } finally { sb.cleanup(); }
});

test("launch.mjs resume closes the lane's dead-start window first, then relaunches it with its effective priority, replacing that entry", { skip: win }, () => {
  const sb = sandbox();
  const h = emptyHost();
  try {
    const w = sessionLine(sb, { name: "W", id: "W@2", group: "g9", branch: "w", gen: 2, sid: "w-s2", host: h, supersedes: null });
    appendLine(sb, { priority: "W", group: "g9", value: "low", at: new Date().toISOString() });
    appendLine(sb, { lane_blocked: "W", group: "g9", handoff: w.handoff, incident: "x/incidents/W-1.md", at: new Date().toISOString() });
    assert.match(sb.run("resume", "--group", "g9", "--dry-run").out, /^would close W \(gen 2\): claude exited \(closed before this launch\)$/m);
    assert.equal(alive(h.pid), true);
    const res = sb.run("resume", "--group", "g9", "--lane", "W");
    assert.equal(res.code, 0, res.err + res.out);
    assert.match(res.out, /^closed W \(gen 2\): claude exited \(closed before this launch\)$/m);
    assert.match(res.out, /^relaunched W fresh \(incident x\/incidents\/W-1\.md\); restart budget reset$/m);
    assert.equal(alive(h.pid), false);
    const w3 = sb.registry().filter((o) => o.name === "W" && o.launched_at).at(-1);
    assert.deepEqual([w3.supersedes, w3.priority, w3.launched_by], [w.id, "low", null]);
  } finally { h.kill(); sb.cleanup(); }
});

test("launch.mjs resume --group relaunches blocked lanes high priority first", () => {
  const sb = sandbox();
  try {
    const at = new Date().toISOString();
    for (const [n, effort] of [["L", "medium"], ["N", "high"], ["H", "xhigh"]]) {
      const e = sessionLine(sb, { name: n, id: `${n}@1`, group: "g8", branch: n.toLowerCase(), sid: `${n}-s1`, effort, supersedes: null });
      appendLine(sb, { lane_blocked: n, group: "g8", handoff: e.handoff, incident: `x/incidents/${n}-1.md`, at });
    }
    const r = sb.run("resume", "--group", "g8", "--dry-run");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.split("\n").filter((l) => l.startsWith("would relaunch")).map((l) => l.split(" ")[2]), ["H", "N", "L"]);
  } finally { sb.cleanup(); }
});
