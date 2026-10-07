// The message delivery hook (PostToolUse and UserPromptSubmit of every launched lane; wired by live.mjs sessionHooks()).
// stdin: the hook JSON. With HL_SESSION_ID it finds the lane's name in the registry, then claims each pending message
// messages/<msgKey(name)>/<rid>.json by claiming it as <rid>.delivered.json (store.rename: an exclusive link + unlink; a
// lost race skips the file), and prints one additionalContext of at most 8 KiB. A pending copy whose claimed copy already
// exists is dropped (store.dropDuplicate), never delivered again. The rest stays pending for the next call. It always exits 0
// and prints nothing when there is nothing to deliver. Reads use read-only fs functions only.
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import path from "node:path";
import * as store from "./store.mjs";
import { stateDir, msgKey, HL_DIR } from "./paths.mjs";

const EVENTS = new Set(["PostToolUse", "UserPromptSubmit"]); // the events that accept additionalContext
const MAX_BYTES = 8192;
const MSG_NAME = /^([0-9a-f]{32})\.json$/;
const MAX_FILES = 200; // a runaway backlog is read in slices: 8 KiB leaves at most a few dozen messages per call anyway
const size = (o) => Buffer.byteLength(JSON.stringify(o));

/** The lane name of the registry launch line with this id (the last one wins), or null. Reads only. */
function laneNameOf(sid) {
  const file = path.join(path.resolve(process.env.HL_REGISTRY_DIR || HL_DIR), "sessions.jsonl");
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(sid)) continue;
    try { const o = JSON.parse(line); if (o && o.id === sid && typeof o.name === "string" && o.launched_at) name = o.name; } catch { /* torn line */ }
  }
  return name;
}

/** Pending messages of a lane, oldest first: [{rid, text, at}]. A file that is not a plain readable message is left alone. */
function pendingOf(name) {
  const dir = path.join(stateDir(), "messages", msgKey(name));
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  // Only pending names count toward the cap: an uncleaned backlog of .delivered.json files must never fill the slots.
  for (const n of names.filter((x) => MSG_NAME.test(x)).sort().slice(0, MAX_FILES)) {
    const m = MSG_NAME.exec(n);
    try {
      if (existsSync(path.join(dir, `${m[1]}.delivered.json`))) { // already handed over: a leftover pending copy is dropped, never delivered again
        try { store.dropDuplicate(`messages/${msgKey(name)}/${n}`); } catch { /* next call */ }
        continue;
      }
      const f = path.join(dir, n);
      if (!lstatSync(f).isFile()) continue;
      const o = JSON.parse(readFileSync(f, "utf8"));
      if (o && typeof o.text === "string" && o.text) out.push({ rid: m[1], text: o.text, at: Date.parse(o.at) || 0 });
    } catch { /* unreadable or half-written: next call */ }
  }
  return out.sort((a, b) => a.at - b.at || (a.rid < b.rid ? -1 : 1));
}

const line = (rid, text) => `Message from the user, relayed by the coordinator (request ${rid}): ${text}`;
const wrap = (event, ctx) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: ctx } });

/**
 * The messages that fit in MAX_BYTES, in order. The first one alone may be cut so a huge message never blocks the queue; its
 * marker names the claimed file (<state>/messages/<key>/<rid>.delivered.json), which keeps the full text. (Claude Code saves
 * hook output over 10,000 characters to disk with a short preview, so the cap stays at 8 KiB: a 10k message cannot fit whole.)
 */
function fit(event, pending, key) {
  const take = [];
  for (const p of pending) {
    const texts = [...take.map((t) => line(t.rid, t.text)), line(p.rid, p.text)];
    if (size(wrap(event, texts.join("\n\n"))) <= MAX_BYTES) { take.push(p); continue; }
    if (take.length === 0) {
      const where = path.join(stateDir(), "messages", key, `${p.rid}.delivered.json`).replaceAll("\\", "/");
      let t = p.text, n = t.length;
      while (n > 0 && size(wrap(event, line(p.rid, t))) > MAX_BYTES) { n = Math.floor(n * 0.9); t = `${p.text.slice(0, n)} [cut: ${p.text.length - n} more characters; full text in ${where}]`; }
      if (n > 0) take.push({ ...p, text: t });
    }
    break;
  }
  return take;
}

function main() {
  const sid = process.env.HL_SESSION_ID;
  if (!sid) return;
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return; }
  const event = input?.hook_event_name;
  if (!EVENTS.has(event)) return;
  if (!existsSync(path.join(stateDir(), "messages"))) return; // nothing was ever queued: no registry read, no state folder created
  const name = laneNameOf(sid);
  if (!name) return;
  const claimed = [], key = msgKey(name);
  for (const p of fit(event, pendingOf(name), key)) {
    try { store.rename(`messages/${key}/${p.rid}.json`, `messages/${key}/${p.rid}.delivered.json`); claimed.push(p); } catch { /* another hook got it first */ }
  }
  if (claimed.length) process.stdout.write(JSON.stringify(wrap(event, claimed.map((p) => line(p.rid, p.text)).join("\n\n"))));
}

try { main(); } catch { /* a hook never fails the tool call */ }
process.exitCode = 0;
