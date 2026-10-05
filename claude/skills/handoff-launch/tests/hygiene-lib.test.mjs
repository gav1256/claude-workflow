// Batch A's pure decisions in recover-lib.mjs: background tasks (Part 2), windows whose claude is gone (Part 3), the
// Playwright reaper and the claude-in-chrome tab set (Part 8), checklists (Part 9). Record shapes copied from real
// transcripts (Claude Code 2.1.289, plan Task 1 probe 4).
import test from "node:test";
import assert from "node:assert/strict";
import * as R from "../recover-lib.mjs";

const MIN = 60000, cfg = R.DEFAULTS, t0 = Date.parse("2026-10-05T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const shellStart = (id, at) => ({ type: "user", timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}` }] },
  toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: id } });
const monitorStart = (id, at, timeoutMs) => ({ type: "user", timestamp: iso(at), toolUseResult: { taskId: id, timeoutMs, persistent: false } });
const note = (id, inner) => `<task-notification>\n<task-id>${id}</task-id>\n<output-file>C:/t/${id}.output</output-file>\n${inner}\n</task-notification>`;
const enqueue = (id, at, inner = "<status>completed</status>\n<summary>Background command completed</summary>") => ({ type: "queue-operation", operation: "enqueue", timestamp: iso(at), content: note(id, inner) });
const attach = (id, at) => ({ type: "attachment", timestamp: iso(at), attachment: { type: "queued_command", prompt: note(id, "<status>completed</status>"), commandMode: "task-notification" } });
const remove = (id, at) => ({ type: "queue-operation", operation: "remove", timestamp: iso(at), content: note(id, "<status>completed</status>") });
const stopped = (id, at) => ({ type: "user", timestamp: iso(at), toolUseResult: { message: `Successfully stopped task: ${id} (node -e setTimeout)`, task_id: id, task_type: "local_bash" } });
const open = (files, o = {}) => R.openBgTasks(files, { sinceMs: t0, nowMs: t0 + 30 * MIN, cfg, ...o }).map((t) => t.id);

test("config: batch A's keys and their defaults", () => {
  assert.deepEqual([cfg.bg_task_max_min, cfg.dead_close_min, cfg.goal_missing_calls, cfg.goal_stale_min, cfg.goal_stale_changes], [240, 60, 10, 40, 5]);
  assert.equal(R.loadConfig('{"dead_close_min": 30}').config.dead_close_min, 30);
});

test("openBgTasks: a started shell task is open until its notification, TaskStop or the safety valve", () => {
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]]), ["b1"]);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), enqueue("b1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), attach("b1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), { type: "user", timestamp: iso(t0 + 2 * MIN), message: { role: "user", content: note("b1", "<status>failed</status>") } }]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), stopped("b1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN), remove("b1", t0 + 2 * MIN)]]), ["b1"]);         // a remove record is no end
  assert.deepEqual(open([[shellStart("b1", t0 - MIN)]]), []);                                            // before the launch line: an earlier process
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]], { nowMs: t0 + MIN + 240 * MIN }), []);           // the safety valve
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]], { nowMs: t0 + MIN + 239 * MIN }), ["b1"]);
  assert.deepEqual(open([[shellStart("b1", t0 + MIN)]], { cfg: {} }), ["b1"]);                          // a cfg without the key: the default, never "all closed"
});

test("openBgTasks: Monitor events are no ends; an expired Monitor or its timeout + 5 min is; a subagent's task ends in the main file", () => {
  const m = monitorStart("m1", t0 + MIN, 10 * MIN);
  assert.deepEqual(open([[m, enqueue("m1", t0 + 2 * MIN, "<event>line 1</event>")]], { nowMs: t0 + 5 * MIN }), ["m1"]);
  assert.deepEqual(open([[m, enqueue("m1", t0 + 2 * MIN, "<event>[Monitor expired after 10m]</event>")]], { nowMs: t0 + 5 * MIN }), []);
  assert.deepEqual(open([[m]], { nowMs: t0 + MIN + 15 * MIN }), []);                                    // timeoutMs + 5 min passed
  assert.deepEqual(open([[m]], { nowMs: t0 + MIN + 14 * MIN }), ["m1"]);
  // A subagent starts the task; the notification arrives in the main transcript.
  assert.deepEqual(open([[enqueue("s1", t0 + 9 * MIN)], [shellStart("s1", t0 + 2 * MIN)]]), []);
  assert.deepEqual(open([[], [shellStart("s1", t0 + 2 * MIN)]]), ["s1"]);
});

test("Part 3: the candidate test (launchOld && (quiet || !transcript)), the kind, and the coordinator-restart match", () => {
  const c = (o) => R.goneCandidate({ launchedAt: iso(t0), lastAt: t0 + MIN, hasTranscript: true, now: t0 + 20 * MIN, cfg, ...o });
  assert.equal(c({}), true);
  assert.equal(c({ lastAt: iso(t0 + MIN) }), true);                            // an ISO lastAt reads as its time
  assert.equal(c({ now: t0 + 9 * MIN, lastAt: t0 }), false);                    // launched under idle_close_min ago
  assert.equal(c({ lastAt: t0 + 15 * MIN }), false);                           // the transcript is not quiet
  assert.equal(c({ hasTranscript: false, lastAt: NaN }), true);                 // no transcript
  assert.equal(c({ hasTranscript: false, now: t0 + 5 * MIN }), false);
  const meta = [{ type: "mode", timestamp: iso(t0 + 1000) }, { type: "system", subtype: "bridge-session", timestamp: iso(t0 + 2000) }];
  assert.equal(R.goneKind(meta, t0), "dead-start");
  assert.equal(R.goneKind(null, t0), "dead-start");
  assert.equal(R.goneKind([...meta, { type: "assistant", timestamp: iso(t0 - MIN) }], t0), "dead-start"); // an older process's record
  assert.equal(R.goneKind([...meta, { type: "assistant", timestamp: iso(t0 + MIN) }], t0), "exited");
  const L = (o) => ({ name: "A", launched_at: iso(t0), ...o });
  const a1 = L({ id: "A@1" }), a2 = L({ id: "A@2" }), a3 = L({ id: "A@3" });
  const rs = { restart: "A", n: 1, kind: "fresh", from: "A@1", at: iso(t0) };
  const lines = [a1, { kill_intent: "A@1" }, { closed: "A", id: "A@1" }, { starting: null, name: "A" }, a2, rs, { lane_blocked: "A" }, a3, { lane_resumed: "A" }];
  assert.equal(R.restartOf(lines, a2), rs);       // the launch line the tick's {restart} followed
  assert.equal(R.restartOf(lines, a1), null);
  assert.equal(R.restartOf(lines, a3), null);     // a later `launch.mjs resume` relaunch is not a coordinator restart
  assert.equal(R.restartOf([a2, { restart: "B", from: "B@1" }], a2), null);
  assert.match(R.DEAD_START_TEXT({ name: "A", branch: "lane-a", launchedAt: t0, closeAt: t0 + 70 * MIN }),
    /^DEAD START: A \(lane-a\): its window is open but claude exited right after the launch at 2026-10-05 10:00 UTC\. Read the error in that window, fix it, relaunch\. The coordinator closes the window at 2026-10-05 11:10 UTC\.$/);
});

test("the Playwright reaper: only orphans with Playwright's signature; live-parent chains, other Playwright browsers and the user's Chrome are kept", () => {
  const c = (h) => t0 - h * 3600e3;
  const procs = [
    { pid: 10, ppid: 1, name: "claude.exe", created: c(5), cmd: "claude" },
    // the npx chain of a live session: claude -> cmd -> npx node -> cmd -> cli node -> chrome
    { pid: 11, ppid: 10, name: "cmd.exe", created: c(4), cmd: "C:\\WINDOWS\\system32\\cmd.exe /d /s /c npx @playwright/mcp@latest" },
    { pid: 12, ppid: 11, name: "node.exe", created: c(4), cmd: "node npx-cli.js @playwright/mcp@latest" },
    { pid: 13, ppid: 12, name: "node.exe", created: c(4), cmd: "node C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\x\\node_modules\\@playwright\\mcp\\cli.js" },
    { pid: 14, ppid: 13, name: "chrome.exe", created: c(3), cmd: "chrome.exe --headless --user-data-dir=C:\\Users\\u\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-AbC123 --remote-debugging-pipe --no-startup-window" },
    // the same chain whose claude is gone: its top is an orphan
    { pid: 21, ppid: 999, name: "cmd.exe", created: c(4), cmd: "cmd.exe /d /s /c npx @playwright/mcp@latest" },
    { pid: 22, ppid: 21, name: "node.exe", created: c(4), cmd: "node npx-cli.js @playwright/mcp@latest" },
    // a pinned direct server whose claude is gone, and its browser
    { pid: 31, ppid: 998, name: "node.exe", created: c(2), cmd: "node C:/Users/u/.claude/mcp-servers/node_modules/@playwright/mcp/cli.js --isolated --headless" },
    { pid: 32, ppid: 31, name: "chrome.exe", created: c(2), cmd: "chrome.exe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-x --remote-debugging-pipe" },
    // a browser whose server died (parent gone)
    { pid: 41, ppid: 997, name: "chrome.exe", created: c(2), cmd: "\"chrome.exe\" --remote-debugging-pipe --user-data-dir=\"C:\\Users\\u\\AppData\\Local\\ms-playwright-mcp\\mcp-chrome-1a2b\"" },
    // `npx playwright test` from a live terminal: same flags, live parent - kept
    { pid: 50, ppid: 1, name: "node.exe", created: c(1), cmd: "node playwright test" },
    { pid: 51, ppid: 50, name: "chrome.exe", created: c(1), cmd: "chrome.exe --remote-debugging-pipe --user-data-dir=C:\\T\\playwright_chromiumdev_profile-y" },
    // the user's own Chrome and Brave, parents gone: neither flag - kept
    { pid: 60, ppid: 996, name: "chrome.exe", created: c(9), cmd: "\"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"" },
    { pid: 61, ppid: 995, name: "brave.exe", created: c(9), cmd: "brave.exe --remote-debugging-pipe" },
    // a pid-reused parent created after its child: an orphan
    { pid: 70, ppid: 71, name: "node.exe", created: c(3), cmd: "node .../@playwright/mcp/cli.js" },
    { pid: 71, ppid: 1, name: "notepad.exe", created: c(1), cmd: "notepad" },
  ];
  assert.deepEqual(R.playwrightOrphans(procs).map((p) => p.pid), [21, 31, 41, 70]);
  assert.equal(R.isPlaywrightProc(procs[13]), false);
  assert.deepEqual(R.playwrightOrphans(null), []);
});

test("stale --isolated profile dirs: older than 24 h and named by no running command line", () => {
  const T = "C:/Users/u/AppData/Local/Temp";
  const dirs = [{ path: `${T}/playwright_chromiumdev_profile-old`, mtimeMs: t0 - 30 * 3600e3 }, { path: `${T}/playwright_chromiumdev_profile-used`, mtimeMs: t0 - 30 * 3600e3 },
    { path: `${T}/playwright_chromiumdev_profile-new`, mtimeMs: t0 - 3600e3 }];
  const procs = [{ pid: 1, cmd: "chrome.exe --user-data-dir=C:\\Users\\u\\AppData\\Local\\Temp\\playwright_chromiumdev_profile-used --remote-debugging-pipe" }];
  assert.deepEqual(R.staleProfileDirs(dirs, procs, t0).map((d) => d.path), [`${T}/playwright_chromiumdev_profile-old`]);
});

test("the claude-in-chrome tab set: ids from tabs_context_mcp / tabs_create_mcp results, minus tabs_close_mcp inputs; garbage adds nothing", () => {
  const ctx = { content: [{ type: "text", text: JSON.stringify({ availableTabs: [{ tabId: 101, title: "New Tab", url: "chrome://newtab/" }, { tabId: 102, title: "x", url: "http://127.0.0.1/" }], tabGroupId: 7 }) }] };
  let s = R.chromeTabs([], { tool: "mcp__claude-in-chrome__tabs_context_mcp", input: { createIfEmpty: true }, response: ctx });
  assert.deepEqual(s, [101, 102]);
  s = R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_create_mcp", input: {}, response: [{ type: "text", text: '{"tabId":103,"url":"about:blank"}' }] });
  assert.deepEqual(s, [101, 102, 103]);
  s = R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_close_mcp", input: { tabId: 102 }, response: "ok" });
  s = R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_close_mcp", input: { tabIds: [101] }, response: "ok" });
  assert.deepEqual(s, [103]);
  assert.deepEqual(R.chromeTabs(s, { tool: "mcp__claude-in-chrome__tabs_context_mcp", response: "Tab 5 is not in Claude's tab group {oops" }), [103]);
  assert.deepEqual(R.chromeTabs("bad", { tool: "Read", response: ctx }), []);
  assert.deepEqual(R.chromeTabs([], { tool: "mcp__claude-in-chrome__tabs_context_mcp", response: { toolUseResult: ctx } }), [101, 102]); // one wrapper more than probe 8
  assert.equal(R.isChromeTool("mcp__claude-in-chrome__navigate"), true);
  assert.equal(R.isChromeTool("mcp__playwright__browser_navigate"), false);
  assert.equal(R.CHROME_TABS_TEXT(2), "You left 2 claude-in-chrome tab(s) open: close them with tabs_close_mcp (only the ones this session opened).");
});

test("parseGoal and goalNote", () => {
  const g = R.parseGoal("# Ship batch A\n\n- [x] spec — evidence: 9b46f93\n- [ ] plan\n* [X] probes\n  - [!] deploy — reason: needs the user's OK\n- not an item\n");
  assert.deepEqual([g.goal, g.items.length, g.done, g.open, g.blocked], ["Ship batch A", 4, 2, 1, 1]);
  assert.equal(g.items[3].reason, "needs the user's OK");
  assert.equal(R.goalNote(g, t0 - 12 * MIN, t0), "goal 2/4 done, 1 blocked (reason: needs the user's OK), last ticked 12 min ago");
  assert.equal(R.goalNote(R.parseGoal("# g\n- [ ] a\n"), t0, t0), "goal 0/1 done, last ticked 0 min ago");
  assert.equal(R.goalNote(null, 0, t0), "no GOAL.md");
});

test("goalSteps: the missing line once after goal_missing_calls main calls; the stale line once per window, re-armed by a write", () => {
  let s = {}, r;
  const call = (o = {}, goal = null) => { r = R.goalSteps(s, { agentId: null, tool: "Read", ...o }, { goal, goalPath: "C:/t/GOAL.md", now: o.now ?? t0, cfg }); s = r.state; return r.context; };
  for (let i = 0; i < 9; i++) assert.equal(call(), null);
  assert.equal(call({ agentId: "ag1" }), null);                       // a subagent's call is not counted and never speaks
  assert.equal(call(), R.GOAL_MISSING_TEXT("C:/t/GOAL.md"));
  assert.equal(call(), null);                                         // once per session
  const goal = { mtimeMs: t0 - 50 * MIN, open: 2 };
  for (let i = 0; i < 4; i++) assert.equal(call({ tool: "Edit" }, goal), null);
  assert.equal(call({ tool: "Bash", agentId: "ag1" }, goal), null);   // a subagent's work counts, but only the main thread speaks
  assert.equal(call({ tool: "Read" }, goal), R.GOAL_STALE_TEXT(50));
  assert.equal(call({ tool: "Edit" }, goal), null);                   // one line per window
  const written = { mtimeMs: t0 - 41 * MIN, open: 2 };                // a GOAL.md write re-arms it
  for (let i = 0; i < 4; i++) assert.equal(call({ tool: "Write" }, written), null);
  assert.equal(call({ tool: "PowerShell" }, written), R.GOAL_STALE_TEXT(41));
  s = {}; assert.equal(call({ tool: "Edit" }, { mtimeMs: t0 - 90 * MIN, open: 0 }), null); // no open items: never stale
  for (let i = 0; i < 6; i++) call({ tool: "Edit" }, { mtimeMs: t0 - 90 * MIN, open: 0 });
  assert.equal(s.goal_stale_said, false);
});

test("restartOf checks the group (plan amendment 7): a same-name lane of another group is a different lane", () => {
  const L = (o) => ({ name: "A", launched_at: iso(t0), ...o });
  const e = L({ id: "A@2", group: "g1" }), other = L({ id: "A@5", group: "g2" });
  const rs = { restart: "A", n: 1, kind: "fresh", from: "A@1", at: iso(t0), group: "g1" };
  // The other group's launch line of the same name sits between e's launch line and e's {restart}: e's restart is still found.
  assert.equal(R.restartOf([e, other, rs], e), rs);
  // The other group's {restart} and {lane_resumed} lines are not e's.
  assert.equal(R.restartOf([e, { ...rs, group: "g2" }], e), null);
  assert.equal(R.restartOf([e, { lane_resumed: "A", group: "g2" }, rs], e), rs);
  // In e's own group a same-name launch line or {lane_resumed} still ends the search.
  assert.equal(R.restartOf([e, L({ id: "A@3", group: "g1" }), rs], e), null);
  assert.equal(R.restartOf([e, { lane_resumed: "A", group: "g1" }, rs], e), null);
  // A legacy {restart} line without a group key still matches (the lines written before Task 5 carry none).
  const legacy = { restart: "A", n: 1, kind: "fresh", from: "A@1", at: iso(t0) };
  assert.equal(R.restartOf([e, other, legacy], e), legacy);
  // The other group's lane finds its own {restart}, never e's.
  const rs2 = { ...rs, from: "A@4", group: "g2" };
  assert.equal(R.restartOf([e, other, rs, rs2], other), rs2);
  // A lane without a group: a grouped launch line of the same name is another lane; a group-less one ends the search.
  const lone = L({ id: "A@7" }), loneRs = { restart: "A", n: 1, kind: "fresh", from: "A@6", at: iso(t0), group: null };
  assert.equal(R.restartOf([lone, other, loneRs], lone), loneRs);
  assert.equal(R.restartOf([lone, L({ id: "A@8" }), loneRs], lone), null);
  assert.equal(R.restartOf([lone, rs], lone), null);
});
