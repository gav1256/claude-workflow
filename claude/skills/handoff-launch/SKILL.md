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
with a paste-ready prompt). The new session only receives a short pointer prompt; everything it needs is in the file.
Before launching, make it durable:
- anything the next session needs that lives only in this session's scratchpad → copy to a durable place
  (the repo's docs, or `~/.claude/experiments/<date>-<topic>/`) and reference that path;
- update project memory with a one-line pointer to the handoff;
- if this session has a `GOAL.md`, mark items moving to the new session `- [!] ... — reason: handed off to <name>`.

## 2. Launch
```
node ~/.claude/skills/handoff-launch/launch.mjs --repo <repo dir> --handoff <path to handoff .md> --name <short-label>
     --model <m> --effort low|medium|high|xhigh|max [--mode window|bg] [--worktree <branch> [--base <ref>]] [--group <id>] [--no-close] [--stop-looping] [--dry-run]
```
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
  generation per repo+branch, window host pid, `--session-id`, group). Append-only.

## 3. Verify and hand over
- Call `ListAgents`: the new session should appear (by its `-n` name) within ~30 s. If it does not, say so and give the
  user the exact launcher command — never claim it started.
- The NEW session is now the controller. This session finishes only what is in flight, dispatches nothing new, and
  tells the user in a few lines: the handoff path, the session name, how to reach it.
- If the launcher printed `stop requested ... deliver with SendMessage to '<name>': <text>`, send that text to that
  session with `SendMessage` (the CLI cannot message an interactive session itself).

## 4. Fan-out: parallel sessions for unrelated tasks, then one merge session
1. The controller writes one handoff per task and one merge handoff, then launches each task with its own branch and the
   same group: `--worktree <branch> --group <id> --name <task>`.
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
   then run `launch.mjs status --group <id>`; if it prints `all_done=true merge_launched=false`, launch the merge handoff:
   `--repo <main repo> --handoff <merge handoff> --group <id> --name <id>-merge --model opus --effort high --worktree <integration branch> --base <target branch>`
   (an exclusive `merge.lock` + the registry refuse a second `<id>-merge`). So the LAST lane to finish starts the merge. (`.superpowers/` must be git-ignored.)
4. The merge handoff's first instruction: run `status --group <id>` and confirm every lane is DONE; review each branch;
   merge them per the repo's normal review/merge rules (never push without asking the user); remove merged worktrees
   (`git worktree remove`); then launch each lane's `next_after_merge` stages as a NEW group (e.g. `<id>` → next id),
   each on a NEW branch with `--base <integration branch>` so it has the merged code, with its own merge handoff. Never
   relaunch a finished lane under the old group: the launcher refuses a lane whose done marker exists (it would read as
   DONE at once and never be merged); `--reopen` (archives the marker) is only for reopening a lane BEFORE the merge.
5. `status` counts an unreadable marker as not done and warns when a marker's `head` is not the branch tip. It also prints
   `merge_lock` (a lock with no merge entry is stale: relaunch the merge with `--force`). Lanes always use `--worktree`
   (the head check reads the lane's recorded branch). `--reopen` is refused once the merge has launched.

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
