# Machine notes (this machine's Claude Code setup)
Facts about this machine, its tools and accounts. Keep bullets short; fix or delete stale ones.

## Claude Code user settings
- `~/.claude/settings.json` registers the goal-gate Stop hook (`~/.claude/hooks/goal-gate.mjs`).
- Untyped subagents (general-purpose, Explore) inherit the session effort.

## Dispatch sizing
- User-scope agents `~/.claude/agents/worker-{low,medium,high,xhigh,max}.md` (frontmatter `effort:`) + `explorer.md` (read-only, medium) and skill `~/.claude/skills/sizing-dispatches` choose effort + model per dispatch.
- The frontmatter key is `effort`, NOT `effortLevel`.
- `disallowedTools: advisor` does NOT remove the server-side advisor; only a body/prompt line ("Do not call the advisor tool.") does.
