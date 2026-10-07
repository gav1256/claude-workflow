import { test } from "node:test";
import assert from "node:assert/strict";
import { foldWorkers, nextWorkerId, focusOf, toSummary } from "../workers.mjs";

const created = (id, extra = {}) => ({
  ev: "created", id, provider: "claude", label: id.replace(/-\d+$/, ""), objective: `obj ${id}`, repo: "/r",
  worktree: "/w", branch: "b", lane: `lane-${id}`, created_at: "2026-10-07T10:00:00Z", ...extra,
});

test("M7 foldWorkers applies created, alias, status and ended events in order", () => {
  const m = foldWorkers([
    created("auth-01"),
    { ev: "alias", worker_id: "auth-01", alias: "login worker" },
    { ev: "alias", worker_id: "auth-01", alias: "login worker" },
    { ev: "status", worker_id: "auth-01", status: "running", summary: "working", blockers: ["b1"], needs_user: false, files_changed: ["a.js"], changes: ["c"] },
    created("ui-01", { provider: "codex", in_worktree_of: "auth-01", fallback_of: "x-01", fallback_reason: "no slot" }),
    { ev: "status", worker_id: "auth-01", status: "waiting_for_user", needs_user: "approve?" },
    { ev: "ended", worker_id: "ui-01", why: "done" },
    { ev: "alias", worker_id: "nobody", alias: "x" },
    { ev: "status", worker_id: "nobody", status: "idle" },
  ]);
  assert.deepEqual([...m.keys()], ["auth-01", "ui-01"]);
  const a = m.get("auth-01");
  assert.equal(a.provider, "claude");
  assert.equal(a.label, "auth");
  assert.deepEqual(a.aliases, ["login worker"]);
  assert.equal(a.status, "waiting_for_user");
  assert.equal(a.last_result, "working");
  assert.deepEqual(a.blockers, ["b1"]);
  assert.equal(a.needs_user, "approve?");
  assert.equal(a.objective, "obj auth-01");
  assert.equal(a.lane, "lane-auth-01");
  const u = m.get("ui-01");
  assert.equal(u.status, "dead");
  assert.equal(u.in_worktree_of, "auth-01");
  assert.equal(u.fallback_of, "x-01");
  assert.equal(u.fallback_reason, "no slot");
  assert.equal(foldWorkers([created("q-01")]).get("q-01").status, "starting");
});

test("M7 nextWorkerId gives auth-01 then auth-02, also after auth-01 ended", () => {
  assert.equal(nextWorkerId("auth", new Map()), "auth-01");
  const lines = [created("auth-01")];
  assert.equal(nextWorkerId("auth", foldWorkers(lines)), "auth-02");
  lines.push({ ev: "ended", worker_id: "auth-01", why: "x" });
  assert.equal(nextWorkerId("auth", foldWorkers(lines)), "auth-02");
  lines.push(created("auth-02"), created("auth-09"));
  assert.equal(nextWorkerId("auth", foldWorkers(lines)), "auth-10");
  assert.equal(nextWorkerId("ui", foldWorkers(lines)), "ui-01");
  assert.equal(nextWorkerId("a-1", new Map([["a-1-05", {}]])), "a-1-06");
});

test("focusOf returns the last focus event's worker (null clears), null when none", () => {
  assert.equal(focusOf([]), null);
  assert.equal(focusOf([{ ev: "focus", worker_id: "a-01" }, created("b-01")]), "a-01");
  assert.equal(focusOf([{ ev: "focus", worker_id: "a-01" }, { ev: "focus", worker_id: null }]), null);
  assert.equal(focusOf([{ ev: "focus", worker_id: "a-01" }, { ev: "focus", worker_id: "b-01" }]), "b-01");
});

test("toSummary caps fields at 200/300/200 and 3 blockers, keeps WorkerSummary keys only", () => {
  const w = foldWorkers([
    created("auth-01", { objective: "o".repeat(500) }),
    { ev: "alias", worker_id: "auth-01", alias: "al" },
    { ev: "status", worker_id: "auth-01", status: "running", summary: "r".repeat(500), blockers: ["a", "b", "c", "d", "e"] },
  ]).get("auth-01");
  w.current_task = "t".repeat(500);
  const s = toSummary(w);
  assert.deepEqual(Object.keys(s).sort(), ["aliases", "blockers", "current_task", "id", "label", "last_result", "objective", "provider", "status"]);
  assert.equal(s.objective.length, 200);
  assert.equal(s.current_task.length, 300);
  assert.equal(s.last_result.length, 200);
  assert.deepEqual(s.blockers, ["a", "b", "c"]);
  assert.deepEqual(s.aliases, ["al"]);
  assert.equal(s.status, "running");
  assert.equal(toSummary(foldWorkers([created("z-01")]).get("z-01")).last_result, "");
});

test("F10 ended is terminal: a later status event does not revive the worker", () => {
  const m = foldWorkers([
    created("auth-01"),
    { ev: "status", worker_id: "auth-01", status: "running" },
    { ev: "ended", worker_id: "auth-01", why: "done" },
    { ev: "status", worker_id: "auth-01", status: "running", summary: "late", needs_user: true },
  ]);
  const w = m.get("auth-01");
  assert.equal(w.status, "dead");
  assert.equal(w.needs_user, false);
  assert.equal(w.last_result, "");
});

test("K5 foldWorkers stamps finished_at from the event time when a worker becomes finished or dead", () => {
  const m = foldWorkers([
    created("a-01"), created("b-01"), created("c-01"), created("d-01"),
    { ev: "status", worker_id: "a-01", status: "finished", at: "2026-10-07T11:00:00Z" },
    { ev: "ended", worker_id: "b-01", why: "x", at: "2026-10-07T11:30:00Z" },
    { ev: "status", worker_id: "c-01", status: "running", at: "2026-10-07T11:00:00Z" },
    { ev: "status", worker_id: "d-01", status: "finished" },
    { ev: "status", worker_id: "a-01", status: "finished", at: "2026-10-07T12:00:00Z" },
  ]);
  assert.equal(m.get("a-01").finished_at, "2026-10-07T11:00:00Z"); // the first move into the state, not a repeat
  assert.equal(m.get("b-01").finished_at, "2026-10-07T11:30:00Z");
  assert.equal(m.get("c-01").finished_at, null);
  assert.equal(m.get("d-01").finished_at, null); // finished with no event time: unknown
  const back = foldWorkers([created("e-01"), { ev: "status", worker_id: "e-01", status: "finished", at: "2026-10-07T11:00:00Z" }, { ev: "status", worker_id: "e-01", status: "running", at: "2026-10-07T11:10:00Z" }]);
  assert.equal(back.get("e-01").finished_at, null);
  assert.equal(foldWorkers([created("f-01")]).get("f-01").finished_at, null);
  assert.equal(foldWorkers([created("g-01", { status: "finished" })]).get("g-01").finished_at, null);
});
