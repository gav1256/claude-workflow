// Shabbat mode, S0: the switch
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandbox, coordRun } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PIO = pathToFileURL(path.join(HERE, "..", "pause-io.mjs")).href;
// The child imports with the sandbox env: these modules read CLAUDE_CONFIG_DIR at import.
const ask = (sb, expr) => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const PI = await import(${JSON.stringify(PIO)}); process.stdout.write(JSON.stringify(${expr}));`], { env: sb.env, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("shabbos: a missing file is on", () => {
  const sb = sandbox();
  try { assert.equal(ask(sb, "PI.shabbosEnabled()"), true); } finally { sb.cleanup(); }
});

test("a malformed file is on", () => {
  const sb = sandbox();
  try {
    const f = path.join(sb.coord, "shabbos.json");
    fs.mkdirSync(sb.coord, { recursive: true });
    for (const t of ["not json", "[]", "{}", '{"enabled":"false"}', '{"enabled":0}', "null", "false", '{"enabled":true}']) {
      fs.writeFileSync(f, t); assert.equal(ask(sb, "PI.shabbosEnabled()"), true, t);
    }
    fs.writeFileSync(f, '{"enabled":false}'); assert.equal(ask(sb, "PI.shabbosEnabled()"), false);
    fs.rmSync(f); fs.mkdirSync(f); assert.equal(ask(sb, "PI.shabbosEnabled()"), true); // unreadable as a file
  } finally { sb.cleanup(); }
});

test("coord.mjs shabbos off, status, on: the round trip", () => {
  const inherited = process.env.HL_OFFTIMES_FILE;
  let sb;
  try {
    process.env.HL_OFFTIMES_FILE = path.join(HERE, "inherited-offtimes.json");
    sb = sandbox();
  } finally {
    if (inherited === undefined) delete process.env.HL_OFFTIMES_FILE;
    else process.env.HL_OFFTIMES_FILE = inherited;
  }
  try {
    const now = Date.UTC(2030, 0, 1);
    sb.env.NODE_OPTIONS = `${sb.env.NODE_OPTIONS || ""} --import=data:text/javascript,${encodeURIComponent(`Date.now = () => ${now};`)}`.trim();
    assert.deepEqual(JSON.parse(fs.readFileSync(sb.offtimes, "utf8")), { tz: "Asia/Jerusalem", until: Date.UTC(2100, 0, 1), intervals: [] });
    assert.equal(sb.env.HL_OFFTIMES_FILE, sb.offtimes);
    assert.equal(ask(sb, "PI.OFFTIMES_FILE"), sb.offtimes);
    const f = path.join(sb.coord, "shabbos.json");
    const on = "shabbos: on (Shabbat/Yom Tov pause and working-time weekly pacing)\n";
    const off = "shabbos: off (plain 7-day pacing, no Shabbat/Yom Tov pause)\n";
    for (const args of [["shabbos"], ["shabbos", "status"]]) {
      const r = coordRun(sb, args); assert.equal(r.code, 0, r.err); assert.equal(r.out, on);
      assert.equal(fs.existsSync(f), false);
    }
    let r = coordRun(sb, ["shabbos", "off"], { env: { HL_SESSION_ID: "M@1", CLAUDE_CODE_SESSION_ID: "fallback" } });
    assert.equal(r.code, 0, r.err); assert.equal(r.out, off);
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepEqual(Object.keys(m).sort(), ["by_session", "changed_at", "enabled"]);
    assert.deepEqual([m.enabled, m.by_session], [false, "M@1"]);
    assert.equal(m.changed_at, now);
    const text = fs.readFileSync(f, "utf8");
    for (const args of [["shabbos", "status"], ["shabbos"]]) {
      r = coordRun(sb, args); assert.equal(r.code, 0, r.err); assert.equal(r.out, off);
      assert.equal(fs.readFileSync(f, "utf8"), text);
    }
    r = coordRun(sb, ["shabbos", "on"], { env: { CLAUDE_CODE_SESSION_ID: "fallback" } });
    assert.equal(r.code, 0, r.err); assert.equal(r.out, on);
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).by_session, "fallback");
    r = coordRun(sb, ["shabbos", "on"]); assert.equal(r.code, 0, r.err); assert.equal(r.out, on);
    assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).by_session, "user");
    const after = fs.readFileSync(f, "utf8");
    for (const args of [["shabbos", "maybe"], ["shabbos", "off", "extra"], ["shabbos", "status", "extra"]]) {
      r = coordRun(sb, args); assert.equal(r.code, 2, r.err); assert.equal(r.out, "usage: shabbos [on|off|status]\n");
      assert.equal(fs.readFileSync(f, "utf8"), after);
    }
    assert.deepEqual(fs.readdirSync(sb.coord), ["shabbos.json"]); // no tmp, tick or watcher files
  } finally { sb.cleanup(); }
});

test("writeShabbos: injected epoch ms, atomic rewrite, returns the path", () => {
  const sb = sandbox();
  try {
    const f = path.join(sb.coord, "shabbos.json"), now = Date.UTC(2030, 0, 1);
    assert.equal(ask(sb, `PI.writeShabbos({ enabled: false, by: "user" }, ${now})`), f);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { enabled: false, changed_at: now, by_session: "user" });
    assert.equal(ask(sb, `PI.writeShabbos({ enabled: true, by: "M@1" }, ${now + 1})`), f);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { enabled: true, changed_at: now + 1, by_session: "M@1" });
    assert.deepEqual(fs.readdirSync(sb.coord), ["shabbos.json"]);
  } finally { sb.cleanup(); }
});

test("offtimes-io imports only live.mjs", () => {
  const text = fs.readFileSync(path.join(HERE, "..", "offtimes-io.mjs"), "utf8");
  const imports = [...text.matchAll(/from\s+["'](\.\/[^"']+)["']/g)].map((m) => m[1]);
  assert.ok(imports.includes("./live.mjs"));
  for (const f of imports) assert.ok(["./live.mjs", "./pace-lib.mjs"].includes(f), f);
});
