// Batch B, Part 6: the /broadcast skill is text; this pins its frontmatter and that every command it tells a session to
// run exists with that shape (coord.mjs pause/resume/tick, launch.mjs resume --paused --all).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandbox, coordRun } from "./helpers.mjs";
import { PAUSE_TEXT } from "../pace-lib.mjs";

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "broadcast", "SKILL.md");

test("broadcast SKILL.md: frontmatter, the four verbs, and the commands it names", () => {
  const t = fs.readFileSync(SKILL, "utf8");
  assert.match(t, /^---\nname: broadcast\ndescription: Use when .+\n---\n/);
  for (const s of ["`ListAgents`", "`SendMessage`", 'node "COORD" pause <args>', 'node "COORD" resume', 'node "COORD" tick', 'node "LAUNCH" resume --paused --all', "claude --resume <session_id> -n <name>"]) assert.ok(t.includes(s), s);
  assert.doesNotMatch(t, /[A-Z]:[\\/]Users[\\/]|\b[\w.-]+@(?!example\.com\b)[\w-]+\.[a-z]{2,}\b/i); // a public repo: no personal paths or addresses
});

test("broadcast SKILL.md: empty output or a non-zero exit is a failure, reported, never 'done'", () => {
  const t = fs.readFileSync(SKILL, "utf8").replace(/\s+/g, " ");
  assert.match(t, /prints nothing, or exits non-zero, has failed/);
  assert.match(t, /never say "done"/);
  assert.match(t, /`restart`\*\*: .*`node "COORD" resume`, then `node "COORD" tick` in the foreground/);
});

test("the commands /broadcast runs answer as the skill says", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["pause", "30m"]);
    assert.equal(r.code, 0); assert.match(r.out, /^Broadcast: Paused \(manual pause until .*\): start no new agents or tasks\./m);
    r = coordRun(sb, ["resume"]);
    assert.equal(r.code, 0); assert.match(r.out, /^Broadcast: resume your saved work\.$/m);
    r = coordRun(sb, ["tick"]);
    assert.equal(r.code, 0, r.err);
    r = sb.run("resume", "--paused", "--all");
    assert.equal(r.code, 0, r.err); assert.equal(r.out, "no paused lanes to relaunch\n");
  } finally { sb.cleanup(); }
});

test("pause prints its end in local time as typed; PAUSE_TEXT says how a pause with no end resumes", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["pause", "30m"]);
    const until = JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "manual.json"), "utf8")).until;
    const local = new Date(until).toTimeString().slice(0, 5);
    assert.match(r.out, new RegExp(`^paused: manual pause until ${local}$`, "m"));
    assert.doesNotMatch(r.out, /\d{4}-\d\d-\d\dT/);
    assert.ok(r.out.includes("Work resumes automatically."));
    r = coordRun(sb, ["pause"]);
    assert.ok(r.out.includes("Work resumes when the pause is lifted (`/broadcast resume`)."), r.out);
    assert.ok(!r.out.includes("Work resumes automatically."));
  } finally { sb.cleanup(); }
  assert.ok(PAUSE_TEXT("pace hold").endsWith("Work resumes automatically.")); // one-arg callers unchanged
  assert.ok(PAUSE_TEXT("manual pause", false).endsWith("Work resumes when the pause is lifted (`/broadcast resume`)."));
});
