# Install prompt

Paste everything inside the box below into a Claude Code session (any folder). It installs this workflow
into your user-scope `~/.claude`, so it applies to every project and every session.

````text
Install the Claude Code workflow from https://github.com/gav1256/claude-workflow into my user-scope
~/.claude so it applies to every session. Work carefully, show me a checklist, and tick each item with evidence.

1. Clone the repo into a temp folder (git clone --depth 1). Everything you install comes from its `claude/` folder.
   Read every file you are about to install before installing it.

2. Back up first: copy ~/.claude/CLAUDE.md, ~/.claude/settings.json, and any ~/.claude/agents, ~/.claude/skills or
   ~/.claude/hooks files that the install would overwrite into ~/.claude/backups/workflow-install-<timestamp>/.
   Never delete anything that is not part of this install.

3. Copy files (create folders as needed):
   - claude/agents/*.md            -> ~/.claude/agents/
   - claude/skills/<each skill>/   -> ~/.claude/skills/<same name>/   (all skill folders in the repo)
   - claude/hooks/goal-gate.mjs    -> ~/.claude/hooks/goal-gate.mjs
   - claude/machine-notes.md       -> ~/.claude/machine-notes.md   ONLY if that file does not exist yet.

4. CLAUDE.md: if ~/.claude/CLAUDE.md does not exist, copy claude/CLAUDE.md there. If it exists, do NOT overwrite it:
   append the repo's sections that are not already present under a heading "# Workflow (from claude-workflow)",
   and show me any instruction in my existing file that conflicts with the new one so I can choose.

5. settings.json: MERGE claude/settings.fragment.json into ~/.claude/settings.json (create it if missing) — never
   replace the file. Rules:
   - Replace __HOME__ in the hook command with my real home directory as an absolute path using forward slashes
     (e.g. C:/Users/me or /home/me). Check `node --version` works; the hooks need Node 18+.
   - hooks.Stop: add the goal-gate entry unless one already points at goal-gate.mjs; keep my existing hooks.
   - enabledPlugins / env / modelSettings: add keys that are missing; for a key I already set, keep my value and tell me.
   - model, effortLevel, advisorModel, remoteControlAtStartup, agentPushNotifEnabled, skipWorkflowUsageWarning:
     set only if I have not set them; list what you changed and what you left alone.
   - Validate the result is valid JSON (parse it with node) before saving.

6. MCP servers (user scope) from claude/mcp-servers.json, skipping any that `claude mcp list` already shows:
     claude mcp add --scope user repomix -- npx -y repomix --mcp
     claude mcp add --scope user ast-grep -- uvx --from git+https://github.com/ast-grep/ast-grep-mcp ast-grep-server
   ast-grep needs `uv` (https://docs.astral.sh/uv/) and the `ast-grep` CLI (`npm i -g @ast-grep/cli`); if either is
   missing, tell me the install command instead of guessing.

7. Plugins: for each plugin in the fragment's enabledPlugins, run `claude plugin install <name>@claude-plugins-official`
   (skip ones `claude plugin list` already shows installed). If the CLI refuses, give me the matching
   `/plugin install ...` commands to type myself.

8. Platform note: the handoff-launch skill's `launch.mjs` opens new sessions in Windows Terminal/PowerShell. If I am
   on macOS or Linux, tell me that `--mode window` is Windows-only. Offer (do not do it unprompted) to adapt it, e.g.
   to `osascript` + Terminal on macOS or to tmux/gnome-terminal on Linux.

9. Verify and report:
   - `node ~/.claude/hooks/goal-gate.mjs < /dev/null` (or `echo {} | node ...` on Windows) exits 0 with no output.
   - `node ~/.claude/skills/handoff-launch/launch.mjs status --group none` prints a `members=0` line.
   - settings.json parses; list the agents, skills and MCP servers now installed.
   - Tell me to RESTART Claude Code so the new agents, skills, hook and settings load, and that after the restart
     typing `/` should list the new skills, and dispatches can use subagent types worker-low … worker-max and explorer.
     (A running session never picks up newly added skills; only a restarted one does.) After the restart, a quick
     check: ask Claude to invoke the `effort-low` skill and then run `echo $CLAUDE_EFFORT` in Bash. It should print `low`.
   Finally delete the temp clone.
````

After the restart, try it: ask Claude for any multi-step task. It should keep a checklist and write a `GOAL.md`
in its scratchpad, and size each subagent with `worker-*`/`explorer` types. When a session gets long, it should hand
off to a fresh session with `handoff-launch`.
