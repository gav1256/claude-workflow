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
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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

test("broadcast SKILL.md: still-paused sends no resume; a pause is for all sessions", () => {
  const t = fs.readFileSync(SKILL, "utf8").replace(/\s+/g, " ");
  assert.match(t, /If it prints `still paused by: \.\.\.`, work is NOT resumed: send NO resume message/);
  assert.match(t, /the tick holds back only the lanes a remaining source covers/);
  assert.match(t, /applies to ALL sessions .* the pause itself cannot honour it - tell the user so/);
});

test("pause prints its end in local time as typed; PAUSE_TEXT says how a pause with no end resumes", () => {
  const sb = sandbox();
  try {
    let r = coordRun(sb, ["pause", "30m"]);
    const until = JSON.parse(fs.readFileSync(path.join(sb.coord, "pause", "manual.json"), "utf8")).until;
    const local = new Date(until).toTimeString().slice(0, 5);
    assert.match(r.out, new RegExp(`^paused: manual pause until ${local}$`, "m"));
    assert.doesNotMatch(r.out, /\d{4}-\d\d-\d\dT/);
    assert.ok(r.out.includes("Work resumes automatically (a hand-opened session: when the user returns)."));
    r = coordRun(sb, ["pause"]);
    assert.ok(r.out.includes("Work resumes when the pause is lifted (`/broadcast resume`)."), r.out);
    assert.ok(!r.out.includes("Work resumes automatically"));
  } finally { sb.cleanup(); }
  assert.ok(PAUSE_TEXT("pace hold").endsWith("Work resumes automatically (a hand-opened session: when the user returns).")); // one-arg callers unchanged
  assert.ok(PAUSE_TEXT("manual pause", false).endsWith("Work resumes when the pause is lifted (`/broadcast resume`)."));
});

test("broadcast SKILL.md description matches the resume phrases", () => {
  const t = fs.readFileSync(SKILL, "utf8");
  assert.match(t, /^---\nname: broadcast\ndescription: Use when .+\n---\n/);
  const description = t.split("\n")[2].toLowerCase();
  for (const phrase of ["resume from before Shabbat / Yom Tov", "resume from pre-shabbos", "resume after chag", "before shabbat"]) assert.ok(description.includes(phrase.toLowerCase()), phrase);
});

test("broadcast resume waits for nightfall and prints hand-opened resume commands", () => {
  const t = fs.readFileSync(SKILL, "utf8"), resume = t.split('- **`resume`**.')[1].split('- **`restart`**')[0].replace(/\s+/g, " ");
  assert.match(resume, /after a Shabbat\/Yom Tov.*lanes relaunch on this command/i);
  assert.match(resume, /`Shabbat\/Yom Tov is still on`.*send NO resume message.*after nightfall/);
  for (const s of ["<coord>/paused.json", "<coord>/paused-*.json", '"closed": false', "claude --resume <session_id> -n <name>", "cwd"]) assert.ok(resume.includes(s), s);
  assert.match(resume, /only channel.*tick raises no alert/);
});

test("resume and restart read both manifests and deduplicate hand-opened sessions", () => {
  const t = fs.readFileSync(SKILL, "utf8");
  const resume = t.split('- **`resume`**.')[1].split('- **`restart`**')[0];
  const restart = t.split('- **`restart`**:')[1].split('- **Anything else**')[0];
  const coordinator = fs.readFileSync(path.join(HERE, "coordinator.md"), "utf8").split("- **Hand-opened resume**:")[1].split("- **External Clean View marker**:")[0];
  for (const section of [resume, restart, coordinator]) {
    const text = section.replace(/\s+/g, " ");
    assert.match(text, /`<coord>\/paused.json` and the newest `<coord>\/paused-\*\.json`/);
    assert.match(text, /both.*once per `session_id`/);
    assert.ok(text.includes("claude --resume <session_id> -n <name>"));
  }
});

test("broadcast resume prints hand commands despite other sources and requires a new request after nightfall", () => {
  const resume = fs.readFileSync(SKILL, "utf8").split('- **`resume`**.')[1].split('- **`restart`**')[0].replace(/\s+/g, " ");
  assert.match(resume, /Whenever `Shabbat\/Yom Tov is still on` is absent.*even if `still paused by: \.\.\.` remains/);
  assert.match(resume, /stay paused until that source lifts/);
  assert.doesNotMatch(resume, /only that source ending lifts it/);
});

test("Shabbat docs require resume after switching off and describe the repo's Clean View marker", () => {
  const lane = fs.readFileSync(path.join(HERE, "SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(lane.includes("(or at once with `/broadcast resume` after `coord.mjs shabbos off`)"));
  const section = fs.readFileSync(path.join(HERE, "coordinator.md"), "utf8").split("## Shabbat mode\n")[1].split(/\n## /)[0].replace(/\s+/g, " ");
  assert.match(section, /generated, until, location, source, license/);
  assert.match(section, /`claude\/mods\/clean-view`.*writes `shabbos.json` itself.*same shape and wording as `coord.mjs shabbos`/);
  assert.match(section, /band's controls row/);
  assert.doesNotMatch(section, /outside this repo|via `coord.mjs shabbos`/);
});

test("Shabbat mode docs cover the table, switch, source, close, user wait and quiet watcher", () => {
  const t = fs.readFileSync(path.join(HERE, "coordinator.md"), "utf8");
  const section = t.split("## Shabbat mode\n")[1]?.split(/\n## /)[0];
  assert.ok(section, "Shabbat mode section");
  assert.ok(t.indexOf("## Shabbat mode") > t.indexOf("## Pausing"));
  for (const s of ["<config>/skills/handoff-launch/offtimes.json", "Asia/Jerusalem", "{start, end, kind}", "generated", "until", "source", "license", "fail open", "plain 7-day", "daily", "60 days", "tools/gen-offtimes.mjs", "--hebcal", "GPL-2.0", "LGPL-2.1", "dev-only", "<coord>/shabbos.json", "coord.mjs shabbos on|off|status", "shabbosEnabled()", "enabled", "false", "changed_at", "by_session", "shabbatSource", "SHABBAT_LEAD_MIN = 60", "scope all", "Shabbat/Yom Tov in <n> min: finish the current step, save state, end your turn.", "Shabbat/Yom Tov has begun: save state and end your turn now. Work resumes when the user asks (/broadcast resume).", "shabbatMark", "shabbatForce", "{paused}", 'by: "tick"', "SHABBAT_GRACE_MIN = 10", "unknown", "killTree", "userWaitEnd", "awaitsUser", "resumePlan", "PI.RESUME_REQUEST", "<coord>/pause/resume-request.json", "PI.writeResumeRequest(now)", "PI.readResumeRequest()", "{at, enabled}", "at > pausedAt", "at >= end", "enabled === false", "manual", "lead hour", "watchStep", "watcherTick", "watchNeeded", "SHABBAT_WATCH_AHEAD_MIN = 120", "no pace", "no power", "no 5-minute back-off", "no alert at nightfall", "hand_via", "Clean View", "✡ Shabbos on", "✡ Shabbos off"]) assert.ok(section.includes(s), s);
  const files = t.split("## Files\n")[1].split("\n## ")[0];
  for (const s of ["shabbos.json", "offtimes.json", "pause/resume-request.json"]) assert.ok(files.includes(s), s);
  const lane = fs.readFileSync(path.join(HERE, "SKILL.md"), "utf8");
  assert.match(lane.replace(/\s+/g, " "), /Shabbat\/Yom Tov.*\/broadcast resume/);
  for (const doc of [t, lane, fs.readFileSync(SKILL, "utf8")]) {
    assert.ok(!doc.includes("\r"), "LF line endings");
    assert.doesNotMatch(doc, /[A-Z]:[\\/]Users[\\/]|\b[\w.-]+@(?!example\.com\b)[\w-]+\.[a-z]{2,}\b/i);
  }
});
