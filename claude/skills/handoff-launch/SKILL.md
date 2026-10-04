---
name: handoff-launch
description: Use when work should continue in a NEW, clean Claude Code session — the context is getting large, a task boundary is reached, or the user asks to "continue in a new session" / "start a fresh session with the handoff". Writes or verifies the handoff document, then opens the new session (a Windows Terminal window by default) already pointed at it, and hands control over.
---

# Handoff launch

Continue work in a fresh session without the user copy-pasting anything.

## 0. When (token-optimal, same rule as ~/.claude/CLAUDE.md "Long work")
Hand off at the FIRST task boundary once context passes ~250k; from ~150k when the next task is unrelated to what is
in context; never later than ~400k (split the task to force a boundary). Never mid-task, and never while background
agents are still running — wait for them, or record them in the handoff as "re-dispatch".

## 1. The handoff must be complete on disk first
A handoff document (house format: repo state, what was done, what is next in order, traps, and a `THE PROMPT` section
with a paste-ready prompt). Multi-session work chains plan-prompt → plan → impl-prompt → implement → next prompt; each prompt
carries read order, house rules, agent protocol, measured baselines and traps written as prohibitions; with no ruled scope
its first instruction is "ask the user". Keep the handoff on disk and refresh it at each task boundary. The new session only receives a short pointer prompt; everything it needs is in the file.
Before launching, make it durable:
- anything the next session needs that lives only in this session's scratchpad → copy to a durable place
  (the repo's docs, or `~/.claude/experiments/<date>-<topic>/`) and reference that path;
- update project memory with a one-line pointer to the handoff;
- if this session has a `GOAL.md`, mark items moving to the new session `- [!] ... — reason: handed off to <name>`.

**Shared checkout** (sessions without worktrees): disjoint file sets; `git commit -- <paths>` commits the WHOLE file, so when a
file also holds another session's uncommitted edits stage only your hunks (`git add -p` / `git apply --cached`) and commit
without paths; never `git checkout` another branch; one session owns rebuilds.

## 2. Launch
```
node ~/.claude/skills/handoff-launch/launch.mjs --repo <repo dir> --handoff <path to handoff .md> --name <short-label>
     --model <m> --effort low|medium|high|xhigh|max [--mode window|bg] [--worktree <branch> [--base <ref>]] [--group <id>] [--profile <names>] [--force] [--no-close] [--stop-looping] [--dry-run]
```
Fan-out subcommands (section 4): `launch.mjs group --group <id> --repo <dir> --integration <b> --target <b> [--test "<cmd>"] [--test-timeout-min <n>] [--mode window|bg] [--force]`,
`launch.mjs merge --group <id> [--repo <dir>] [--lane <name>] [--skip <lane> [--session <merge session>] --why <reason>] [--force] [--dry-run]`,
`launch.mjs overlap --group <id> [--repo <dir>] [--dry-run]`, `launch.mjs status --group <id> [--repo <dir>] [--no-merge] [--dry-run]`.
- `--model` + `--effort` are REQUIRED (the launcher refuses without them): size each session for ITS task before launching (user directives 2026-10-01). **Sizing the session** — judge two things, difficulty and length:

  | Session's task | `--model` | `--effort` |
  |---|---|---|
  | mechanical: doc edits, test/live-run babysitting, merges of reviewed branches | `opus` | `medium` |
  | normal controller: plans, dispatches, judges reviews | `opus` | `high` |
  | long AND hard: cross-cutting design, many rulings, multi-wave implementation | `opus` | `xhigh` (fable stays the reviewer via dispatch — too costly as a long controller) |
  | SHORT but very hard: one security/data-integrity ruling, a root cause nobody found, a high-stakes spec decision, bounded scope | `fable` | `high` |
  | short and the hardest class (correctness proof, an incident with data at risk) | `fable` | `xhigh` (`max` only if xhigh already failed on it) |

  Never Haiku; never sonnet as a session (sonnet is a mechanical subagent tier). If a session fails its task, relaunch one rung up. State the chosen row + reason in one line when reporting the launch. The session's subagents are still sized per dispatch by `sizing-dispatches`.
- Worktree sessions inherit the main checkout's `.claude/settings.local.json` (MCP approvals + allow rules, merged into any existing file), so they start without an "enable MCP servers?" prompt.
- `window` (default): new Windows Terminal window, interactive `claude` session, visible to the user. Windows only — the launcher refuses it on other OSes (use `bg`).
- `bg`: Claude Code background session (`claude agents` to list, `claude attach <id>` to open). Background sessions
  cannot edit the main checkout until they enter a worktree — use `window` for work that writes to the checkout.
- `--worktree <branch>`: the session runs in `<repo>/.claude/worktrees/<branch-slug>` (created from `--base`, default
  the repo's HEAD; reused if it exists). The main checkout is never checked out. The handoff is passed by absolute path.
- The launcher strips this session's `CLAUDE_*` environment and reloads PATH from the registry, so the child is a
  genuinely new session. Run with `--dry-run` first if anything looks unusual: it shows the worktree action, the
  registry line, the windows it would close and the watchdog findings, and changes nothing.
- Every launch is recorded in `~/.claude/skills/handoff-launch/sessions.jsonl` (name, repo, branch, worktree,
  generation per repo+branch, window host pid, `--session-id`, group, profile). Append-only.

### Lane profiles and the session cap
`--profile a,b` (from `profiles.json`) picks what heavy tooling a session keeps; names union, `lean` is implied, the
default is `lean`. Every other heavy plugin is disabled via one `--settings` file, and only the kept MCP servers run
(`--strict-mcp-config --mcp-config <file>`, which also drops plugin MCP servers and claude.ai connectors; plugin skills still load).

| Profile | Keeps | Measured RAM it saves per session |
|---|---|---|
| `lean` (default) | no heavy plugin, no MCP server | ~480 MB (22 procs / 513 MB of children -> ~35 MB) |
| `python` | pyright LSP (lanes editing Python that want diagnostics) | pyright costs ~230 MB once a .py is edited |
| `browser` | playwright | playwright costs ~140 MB |
| `maps` | the `google-maps` server from the work dir's `.mcp.json` | - |
| `explore` | `repomix` + `ast-grep` from `~/.claude.json` | they cost ~150 + ~120 MB |
| `full` | everything: no profile flags (the old behaviour) | 0 |

An unknown profile or MCP server exits 2. The generated files live in `<registry dir>/profiles/` (content-addressed;
`--dry-run` writes them too, nothing else). The registry line records the canonical `profile`; for a restart,
`launch.mjs profile-args --profile <it> [--repo <work dir>]` prints `{"profile", "args"}` for `claude --resume <id> <args>`
(keep the args before any prompt: `--mcp-config` is variadic).
A `.mcp.json` or `~/.claude.json` that exists but is not valid JSON also exits 2, naming the file.
Registry entries without `profile` were launched before profiles existed (all plugins and servers): restart them with
`--profile full`, or pick a lane profile on purpose.
**Session cap**: a launch is refused (exit 3) before it creates or records anything, while ≥ `max_sessions` (6, an
integer ≥ 1) other sessions run (windows whose host is alive or unproven, bg sessions `claude agents` lists as
unfinished; the newest one on the same repo+branch is not counted - a relay replaces it) or free RAM < `min_free_gb`
(3). Config: `<registry dir>/launch-config.json`. It counts launcher sessions only: hand-opened sessions are not
counted (the free-RAM floor covers them), and a window whose claude exited still counts until its window is closed.
Merge sessions (`<group>-merge...`) are exempt. Close idle sessions first; `--force` overrides it only with the user's
OK. `--dry-run` reports `cap` and never refuses.

## 3. Verify and hand over
- Call `ListAgents`: the new session should appear (by its `-n` name) within ~30 s. If it does not, say so and give the
  user the exact launcher command — never claim it started.
- The NEW session is now the controller. This session finishes only what is in flight, dispatches nothing new, and
  tells the user in a few lines: the handoff path, the session name, how to reach it.
- If the launcher printed `stop requested ... deliver with SendMessage to '<name>': <text>`, send that text to that
  session with `SendMessage` (the CLI cannot message an interactive session itself).

## 4. Fan-out: parallel lanes, merged as each one finishes
1. **Set up the group once, before launching any lane:**
   `node ~/.claude/skills/handoff-launch/launch.mjs group --group <id> --repo <main repo> --integration <branch> --target <branch> [--test "<cmd>"]`
   It writes `.superpowers/sessions/<id>/config.json` (`.superpowers/` must be git-ignored). The test command runs in
   the merge worktree `.claude/worktrees/_merge-<id>` on the integration branch, so it installs what it needs (e.g.
   `npm ci && npm test`); default timeout 30 min (`--test-timeout-min`). That worktree persists across merges
   (installed deps and build output stay); the test must not modify tracked files. Then write one handoff per task and
   launch each with its own branch and the same group: `--worktree <branch> --group <id> --name <task>`.
   `group --force` on a group that already launched lanes switches it to rolling merges mid-flight: do not, except
   before any lane finished.
2. **Lanes never wait for each other** (user directive 2026-10-01). Each member (`--name`) is a LANE: its whole wave of
   stages, not one handoff. When a stage finishes and the lane has a next stage that does not need another lane's
   unmerged work, START IT NOW in a NEW session: write that stage's handoff and launch it via this skill with the SAME
   `--name`, `--group` and `--worktree <same branch>`, sized for that stage, passing `--handoff` as an ABSOLUTE path (the
   registry keeps the latest entry per name, so the done marker stays the same). Only a small follow-up (≲ 1 hour, context still < ~150k) continues in the
   same session. Stages inside an already-ruled wave (the lane's own ledger/plan) need no ask-before-handoff; anything else (memory
   queues, a new feature) → ask the user before starting it. Never idle waiting for a sibling.
3. **Done contract** — only when the lane's whole wave is finished (or blocked, or its next stage needs another lane's
   unmerged work): commit on its own branch (never push, never merge), then write
   `<main repo>/.superpowers/sessions/<id>/<name>.done` (the pointer prompt names the exact path) as JSON
   `{"name","branch","head":"<sha>","status":"done|blocked","tests":"<real test output summary>","next_after_merge":[...],"at"}`,
   then run `launch.mjs merge --group <id> --repo <main repo> --lane <name>` (the pointer prompt has the exact command)
   and act on its output:
   - `merged <lane> -> <integration> <sha>`: done; tell the user in one line.
   - `queued: ...`: another merge holds the lock and picks this lane up after its own. Nothing to do, unless the line
     says STALE or names merge --skip/--force: then pass it to the user.
   - `MERGE-BLOCKED <lane>: ...`: if `<lane>` is yours, your marker's `head` is unusable - rewrite the marker with
     `head` = `git rev-parse <your branch>` and run merge again (a new head is queued again); otherwise report it in
     one line.
   - `CONFLICT ...` / `TEST FAILED ... merge session <id>-merge-<lane> launched`: that session (opus/high) resolves it.
     Nothing to do.
   - `FINAL_READY ...`: every lane is merged or blocked. Ask the user to approve the final merge of the integration
     branch into the target (never push without asking). After it, set up a NEW group with `launch.mjs group` (step 1;
     without it the group silently becomes a legacy group), then launch the listed `next_after_merge` stages in it,
     each on a NEW branch with `--base <target>`.
   - `ERROR ...` (exit 1): report it to the user verbatim. Never delete the lock or edit the merge worktree yourself.
   - `merge.lock changed hands repeatedly - run merge again`: run the same merge command once more.
   - Anything else (`lane <name>: <state>`, `nothing to merge`, `merged ... (already contained ...)`): report it in one
     line.
4. **How merges run** (code, zero tokens): one at a time under `.superpowers/sessions/<id>/merge.lock`, in the scratch
   worktree `.claude/worktrees/_merge-<id>` (never a lane's): `git merge --no-ff --no-commit <marker head>`, the test
   command, then the commit. A conflict or a failing test aborts the merge (the integration branch does not move) and
   launches `<id>-merge-<lane>` with a generated handoff listing the conflicts and the test output. That session holds
   the lock until its last step, `launch.mjs merge --group <id>`, sees the lane merged, releases the lock and merges
   the lanes that finished meanwhile. Running lanes are never touched. Pass `--repo <main repo>` to `merge`, `status`
   and `overlap`.
   - `status --group <id>` also merges finished lanes (`--no-merge` only looks). Per lane it shows `MERGED`/`QUEUED`/
     `MERGE-BLOCKED` and `overlap=` (files a finished lane shares with running lanes; also `launch.mjs overlap --group
     <id>`). The summary adds `merged= queue=[..] merge_holder= final_ready=`; `merge_launched=true` means a merge
     session holds the lock. Its merge step prints `merge: ...` lines and `status` exits 0 even after `merge: ERROR ...`:
     read the output, not the exit code.
   - `--dry-run` on `merge`, `status` or `overlap` writes nothing (no merge, no launch, no overlap in the markers);
     `merge --dry-run` prints the order it would merge in and the lock holder.
   - Recovery: a lock whose merge process died is reclaimed by the next merge, which also aborts an unfinished merge
     left in the merge worktree.
   - `merge --group <id> --skip <lane> --why "<reason>"` gives up on the lane's current head (`MERGE-BLOCKED`; a new
     done-marker head is queued again) and frees its merge session's lock. Refused (exit 1) for a merged lane, while the
     lane's merge is in progress in the merge worktree (`git merge --abort` there first), and while that lane's merge
     session is still running unless `--session <that session>` is given (its own handoff's skip command passes it).
   - `merge --group <id> --force` clears a lock that status reports as STALE (the merge process died, or the merge
     session's window closed or its process ended) or older than the test timeout; the lane is retried. It aborts
     nothing itself. Refused (exit 1, nothing merged) while a live merge process younger than the test timeout holds
     the lock, while the holding merge session is still running (`launch.mjs stop --name <session>` or close its window
     first), while a merge session's half merge is in progress in the merge worktree (abort a half merge in the merge
     worktree first: `git merge --abort` there), or when that lane is already merged (run plain `merge`). With both
     flags, `--skip` runs before `--force`.
   - Large-org variant: a merge queue or CI-gated pull request per lane instead of local merges.
5. Never relaunch a finished lane under the old group: the launcher refuses a lane whose done marker exists (it would
   read as DONE at once). `--reopen` (archives the marker) reopens a lane only before it is merged (refused while it is
   merged or being merged); a reopened lane's new head is merged like any other.
6. `status` shows an unreadable or JSON `null` marker as `UNREADABLE` and does not count it as done, and warns when a
   marker's `head` is not the branch tip. Lanes always use `--worktree` (the head check reads the lane's recorded branch).
7. **Legacy groups** (no `config.json`, launched before 2026-10-03) keep the old flow: after its done marker, the lane
   runs `status --group <id>`; on `all_done=true merge_launched=false` it launches the merge handoff:
   `--repo <main repo> --handoff <merge handoff> --group <id> --name <id>-merge --model opus --effort high --worktree <integration branch> --base <target branch>`
   (an exclusive `merge.lock` + the registry refuse a second `<id>-merge`). That merge session confirms every lane is
   DONE, reviews and merges each branch (never pushes without asking), removes merged worktrees, and launches each
   lane's `next_after_merge` stages as a NEW group, each on a NEW branch with `--base <integration branch>` (so it has
   the merged code), with its own merge handoff. `merge_lock` without a merge entry is stale: relaunch with `--force`.
   `--reopen` is refused once that merge has launched. `launch.mjs merge` (any flag) on a legacy group only prints this
   flow and changes nothing.

## 5. Auto-close, stop and watchdog
- **Auto-close** (window launches): after launching generation N on a repo+branch, the windows of generations ≤ N-2 there
  are closed — only if the window's process is still the PowerShell host recorded at launch (PID-reuse guard) AND its
  session is idle (finished turn, no outstanding tool call, no background agents) for ≥ 10 min. A busy session gets a
  stop request instead and a later launch retries. Generation N-1 is never closed. `--no-close` disables it.
- **Watchdog** (runs at every launch; also `launch.mjs watchdog [--repo <dir>]`): flags a session repeating the same
  tool call ≥ 4× in its last 20 entries, stuck ≥ 30 min on an outstanding tool call, or getting ≥ 5 goal-gate nudges in its last 60 entries (up to 3 per turn is normal).
  With `--stop-looping` it sends a stop request, and kills the window tree if the session still loops ≥ 5 min later.
  Every kill writes its reason to the registry first.
- **Stop contract** — any session that receives a `STOP REQUEST` (or `launch.mjs stop --name <n>` was run for it):
  finish or cancel the in-flight tool call, `TaskStop` every background agent it started, record its state in its
  ledger/handoff, then end its turn and start no new work.
