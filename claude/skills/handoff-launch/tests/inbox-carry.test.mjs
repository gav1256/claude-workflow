// Batch B (carried from batch A): a fresh launch that replaces an entry of its lane names that entry's taken inbox too -
// after a dead start the earlier session never read it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox } from "./helpers.mjs";
import { PREV_INBOX_SENTENCE } from "../lane-lib.mjs";

const fwd = (p) => p.split(path.sep).join("/");
const launches = (sb, name) => sb.registry().filter((o) => o.launched_at && o.name === name);

test("a launch with --supersedes X of the same lane names X's taken inbox; none when X took none, or for another lane", () => {
  const sb = sandbox();
  try {
    const run = (...a) => sb.run("--repo", sb.repo, "--handoff", sb.handoff, "--model", "opus", "--effort", "high", ...a);
    assert.equal(run("--name", "A").code, 0);
    assert.equal(sb.run("queue", "--to", "A", "--text", "fix the parser").code, 0);
    let r = run("--name", "A", "--supersedes", launches(sb, "A")[0].id); // takes the inbox (then, say, a dead start)
    assert.equal(r.code, 0, r.err);
    const x = launches(sb, "A")[1], dir = path.join(sb.cfg, "state", "coord", "inbox");
    const taken = fs.readdirSync(dir).find((f) => f.endsWith(".taken.md"));
    assert.equal(taken, `A.${x.id.slice(x.id.indexOf("@") + 1)}.taken.md`);
    r = run("--name", "A", "--supersedes", x.id, "--dry-run"); // its fresh restart
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).prompt.endsWith(PREV_INBOX_SENTENCE(fwd(path.join(dir, taken))).replace(/"/g, "'").replace(/;/g, ",")));
    r = run("--name", "A", "--supersedes", launches(sb, "A")[0].id, "--dry-run"); // A@1 took nothing
    assert.doesNotMatch(JSON.parse(r.out).prompt, /predecessor took/);
    assert.equal(run("--name", "B").code, 0);
    r = run("--name", "B", "--supersedes", x.id, "--dry-run"); // another lane's entry: not its inbox
    assert.doesNotMatch(JSON.parse(r.out).prompt, /predecessor took/);
  } finally { sb.cleanup(); }
});
