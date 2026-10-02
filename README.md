# claude-workflow

My Claude Code setup for long, multi-session, multi-agent work: global instructions, effort-sized subagents,
a goal gate that stops sessions from quitting early, automatic hand-off to fresh sessions, and the MCP servers
and plugins they lean on.

**To install it, paste [`INSTALL_PROMPT.md`](INSTALL_PROMPT.md) into Claude Code.** The prompt backs up your
`~/.claude` first, merges instead of overwriting, and verifies the result.

## What's inside (`claude/` mirrors `~/.claude/`)

| Path | What it does |
|---|---|
| `CLAUDE.md` | Global working protocol: token economy, checklists + `GOAL.md`, closed-loop verification, delegation, model choice, hand-off thresholds, cross-session learning. |
| `agents/worker-{low,medium,high,xhigh,max}.md` | General workers pinned to one reasoning effort each. The Agent tool sets `model` per call but not effort, so effort is chosen by agent type. |
| `agents/explorer.md` | Read-only explorer (medium effort) that returns `path:line` anchors, not file dumps. |
| `skills/sizing-dispatches/` | The table that picks `subagent_type` + `model` for every dispatch, plus the escalation ladder when a dispatch fails. |
| `skills/handoff-launch/` | Continues work in a NEW session pointed at a handoff doc (`launch.mjs`): Windows Terminal window or background session, git worktrees per lane, parallel fan-out lanes with done markers and an automatic merge session, auto-close of stale windows, and a loop watchdog. |
| `skills/switching-effort/` + `skills/effort-{low,medium,high,xhigh,max}/` | Lets a session **or a subagent** change its own reasoning effort mid-turn: invoking `effort-<level>` overrides the effort until the turn ends (verified with a hook that logs `effort.level` on every tool call). On Opus 5.5, Sonnet 5.5 and Fable 5.1 (API key or subscription) the prompt cache survives the switch; on other models it does not, and the guidance skill says when it is still worth it. |
| `hooks/goal-gate.mjs` | Stop hook: while `GOAL.md` in the session scratchpad has open `- [ ]` criteria, the session keeps working. It is loop-guarded (max 3 continuations per turn, gives up after a no-change continuation) and fails open. |
| `settings.fragment.json` | Settings to merge: the Stop hook, model/effort defaults, plugins, MCP timeouts. `__HOME__` is replaced at install. |
| `settings.optional.json` | Personal preferences the installer asks about one by one: Fable as the advisor model, Remote Control at startup, push notifications. |
| `mcp-servers.json` | User-scope MCP servers: `repomix` (pack a code area into one snapshot) and `ast-grep` (structural code search). |
| `machine-notes.md` | Template for per-machine facts that `CLAUDE.md` points to. |

## How it fits together

1. Every multi-step task starts with a checklist and a `GOAL.md` of objectively checkable criteria. The goal-gate
   hook won't let the session stop while criteria are open, unless one is marked `[!] blocked — reason: …`.
2. The main session plans and rules on decisions; implementation, review, debugging and research go to subagents
   sized by `sizing-dispatches` (e.g. `worker-low` + sonnet for test runs, `worker-xhigh` + fable for reviewing
   security-critical code).
3. When context gets large (~250k at a task boundary), the session writes a handoff document and `handoff-launch`
   opens a fresh session already pointed at it. Parallel lanes run in their own worktrees, and the last one to
   finish launches the merge session.
4. Within a turn, a session or worker steps its effort down for mechanical stretches and up for hard rulings with the
   `effort-*` skills. The model cannot run `/effort` itself, so this is its only lever; a lasting change is still the
   user typing `/effort <level>`.

## Requirements and caveats

- Claude Code with access to Opus/Sonnet (and Fable for the reviewer rows); Node 18+; git. `ast-grep` needs `uv`.
- `handoff-launch --mode window` is **Windows-only** (Windows Terminal/PowerShell). `--mode bg` (works everywhere) and the
  `status`/`stop` subcommands are portable. On macOS/Linux, ask Claude to adapt the window launcher.
- Opinionated defaults: "never Haiku", "never sonnet as a main session", and fable as the high-stakes reviewer.
  Edit `CLAUDE.md` and `sizing-dispatches` to taste.
- With a custom `CLAUDE_CONFIG_DIR`, the installer puts files there, but `launch.mjs` (watchdog/auto-close) and the
  goal gate's fallback path still look for transcripts and goals under `~/.claude`.

## License

MIT
