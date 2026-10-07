# Cheap-model coordinator ("<Model> Coordinator") — design

Date: 2026-10-07. Status: draft for user review.

## Goal
Replace the Claude coordinator session with a routing-only session run by a cheaper model (DeepSeek first). The
user types a message; the coordinator forwards it to the running session that owns the topic, or opens a new
Claude session for it. It remembers every session across its own restarts and can reopen sessions that closed
without finishing. Claude is billed only for the worker sessions that do the real work.

## What the user said (requirements)
- R1. Looks and behaves like the Claude Code CLI with the user's mods; the window title is the running model's name
  plus "Coordinator" (DeepSeek → "DeepSeek Coordinator"). Swapping the model changes the title.
- R2. Model: DeepSeek, via its API key, set up once.
- R3. Route only: list sessions, send a message to one, open a new session. No code work.
- R4. Knows at any time which sessions are open, closed or paused and what each is doing, even after the
  coordinator itself is closed and restarted.
- R5. "Restart the closed sessions" reopens the sessions that were open and closed without finishing.
- R6. May write Markdown and coordinator state files for history; may edit nothing else.

- R7. Model-agnostic: the user may pick a different model and supply its key later. Nothing is hard-wired to
  DeepSeek; DeepSeek is only the worked example.

## Provider config
One file outside every repo, `~/.claude/coordinator/provider.json` (user-only), holds `baseUrl`, `model`,
`displayName` and `keyFile`. The launcher reads it; swapping the model means editing this file only. If the
provider speaks the Anthropic Messages format it plugs in directly; if it only speaks the OpenAI format, a local
LiteLLM proxy sits in between and `baseUrl` points at the proxy. T1-T5 run without any key (fake provider).

## Assumptions (not stated by the user)
- A1. The coordinator runs the real Claude Code CLI, pointed at DeepSeek's Anthropic-compatible endpoint
  (`ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`, `ANTHROPIC_AUTH_TOKEN=<key>`,
  `ANTHROPIC_MODEL=deepseek-chat` or the current flagship). No translation proxy. Source: DeepSeek docs,
  https://api-docs.deepseek.com/guides/anthropic_api.
- A2. Sessions it opens are normal Claude sessions launched by the existing `handoff-launch` launcher.
- A3. Messages are forwarded verbatim; the coordinator adds at most a one-line header naming itself.

## Architecture

### 1. Launcher (`coordinator` profile)
- One command (`coord-start`) opens a Windows Terminal window running `claude` with the DeepSeek env vars set **for
  that process only**, plus `--settings` pointing at the coordinator's settings file (section 2) and
  `--append-system-prompt` with the routing rules (section 3).
- Title = display name derived from `ANTHROPIC_MODEL` (table: `deepseek-*` → "DeepSeek"; unknown → the raw id) +
  " Coordinator".
- Key storage: the DeepSeek key lives in a user-only file outside every repo (for example
  `~/.claude/secrets/deepseek.key`); the launcher reads it. Never written to git, logs or the journal.
- **Env isolation (critical).** Sessions the coordinator opens must run on Claude, not DeepSeek. The launch path
  strips `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` from the
  child environment before spawning (`live.mjs` `spawnWindow`, `~/.claude/skills/handoff-launch/live.mjs:621`).
  A test proves a child launched from the coordinator has none of them.

### 2. Permissions (enforced by settings, not by instructions)
- Allow: `ListAgents`, `SendMessage`, `Read`, `Grep`, `Glob`.
- Allow `Bash` only for a fixed list of coordinator commands: `node ~/.claude/hooks/coord.mjs tick --dry-run`,
  the `handoff-launch` launcher (open a session), the reopen command (section 5), and the journal helper.
- Allow `Write`/`Edit` only under the coordinator's state directory (`~/.claude/coordinator/**`) and `*.md` there.
- Deny everything else: `Agent`, `Workflow`, `PowerShell`, other `Bash`, `Write`/`Edit` elsewhere, web tools.
- Small-company default: one settings file. Large-org variant: a separate OS user for the coordinator.

### 3. Routing rules (system prompt)
For each user message:
1. Refresh the session picture (section 4).
2. If one live session clearly owns the topic (same project, same lane, current task matches), `SendMessage` it
   verbatim.
3. If none matches, open a new Claude session via the launcher with the message as its brief.
4. If two or more are plausible, ask the user one short question listing them. Never guess between them.
5. Reply with one line: `→ sent to <name>` / `→ opened <name>` / `? which one: a, b`.
6. Append one journal line (section 4).
It never answers coding questions itself; a question about status is answered from the session picture.

### 4. Memory that survives restarts
- **Source of truth for sessions:** the existing launcher registry (`readRegistry`,
  `~/.claude/skills/handoff-launch/live.mjs:58`), liveness (`liveness`, `:310`), state (`sessionState`, `:411`) and
  goals (`goalOf`, `:457`). The coordinator does not keep a second registry.
- **Journal:** `~/.claude/coordinator/journal.md`, append-only, one line per event: time, user message (first 120
  chars), decision, target session. Written through a helper so the format is fixed.
- **Status command** (`coord.mjs status --json` or a small `coordinator-status.mjs`): one call returns every known
  session with name, project, open/closed/paused, close reason (finished, paused, crashed, window closed), current
  goal line and last activity. The coordinator calls it at startup and before each routing decision.
- On startup it reads the status and the last 50 journal lines, so "what's going on?" has an immediate answer.

### 5. "Restart the closed sessions"
- Candidates: registry entries whose last state is closed **without** a finished marker (paused, crashed, window
  closed). Finished sessions are excluded.
- The coordinator lists candidates, waits for the user's yes, then reopens each through the existing reopen path
  used by the `broadcast` skill's "reopen the sessions a pause closed" (`recover.mjs` / `recover-lib.mjs`), extended
  to the crashed and window-closed cases.

## Error handling
- DeepSeek API down or key invalid: the window shows the CLI's own error; nothing is routed; the journal is
  untouched.
- Target session went offline between status and send: report it and offer to reopen or open new.
- Launcher failure: report the launcher's real error line; no retry loop.

## Testing
- T1. Routing dry run: fake registry with 3 sessions + 6 sample messages → expected decisions (send / open / ask).
- T2. Permission check: in the coordinator profile, an edit outside `~/.claude/coordinator/`, a non-listed Bash
  command and an `Agent` call are all refused.
- T3. Env isolation: a session opened from the coordinator has no `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`.
- T4. Restart memory: close and reopen the coordinator; status answer matches the registry.
- T5. Reopen: a paused and a crashed fake session are offered; a finished one is not.
- T6. Live: one real message routed to an idle session (fake address only, no real email).

## Out of scope (V1)
- Phone or chat-app input. Upkeep work (merges, reviews, closing sessions). Multiple coordinator models at once.
