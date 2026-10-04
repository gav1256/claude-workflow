# Install prompt

Paste everything inside the box below into a Claude Code session (any folder). It installs this workflow
into your user-scope `~/.claude`, so it applies to every project and every session.

````text
Install the Claude Code workflow from https://github.com/gav1256/claude-workflow into my user-scope Claude config
so it applies to every session. Work carefully, show me a checklist, and tick each item with evidence.

The config directory (CONFIG below) is $CLAUDE_CONFIG_DIR if that is set, otherwise ~/.claude. Whenever you run a
command, write the path as an absolute path or as "$HOME/..." in quotes, never as a bare ~ (PowerShell does not
expand ~ for native programs).

1. Clone the repo into a temp folder (git clone --depth 1). Everything you install comes from its `claude/` folder.
   Read every file you are about to install before installing it.

2. Back up first: copy CONFIG/CLAUDE.md, CONFIG/settings.json, and any CONFIG/agents, CONFIG/skills or CONFIG/hooks
   files that the install would overwrite into CONFIG/backups/workflow-install-<timestamp>/.
   Never delete anything that is not part of this install.

3. Copy files (create folders as needed):
   - claude/agents/*.md            -> CONFIG/agents/
   - claude/skills/<each skill>/   -> CONFIG/skills/<same name>/   (every skill folder in the repo)
   - claude/hooks/goal-gate.mjs    -> CONFIG/hooks/goal-gate.mjs
   - claude/hooks/coord.mjs        -> CONFIG/hooks/coord.mjs
   - claude/machine-notes.md       -> CONFIG/machine-notes.md   ONLY if that file does not exist yet.

4. CLAUDE.md: if CONFIG/CLAUDE.md does not exist, copy claude/CLAUDE.md there. If it exists, do NOT overwrite it:
   append the repo's sections that are not already present under a heading "# Workflow (from claude-workflow)",
   and show me any instruction in my existing file that conflicts with the new one so I can choose.
   Before saving, show me these personal-preference lines and ask whether to keep each one: the "Docker" line
   (it allows all docker actions without asking) and "Tests and probes" (fake email addresses).

5. settings.json: MERGE claude/settings.fragment.json into CONFIG/settings.json (create it if missing). Never replace
   the file. Rules:
   - In the hook command, replace the quoted path "__HOME__/.claude/hooks/goal-gate.mjs" with the absolute path of
     CONFIG/hooks/goal-gate.mjs, using forward slashes (e.g. "C:/Users/me/.claude/hooks/goal-gate.mjs"). Keep the
     double quotes; they protect paths with spaces.
     Check that `node --version` reports 18 or newer.
   - hooks.Stop: add the goal-gate entry unless one already points at goal-gate.mjs; keep my existing hooks.
   - enabledPlugins / env / modelSettings: add missing keys; for any key I already set, keep my value and tell me.
   - model, effortLevel, skipWorkflowUsageWarning: set only if I have not set them.
   - claude/settings.optional.json holds personal preferences: advisorModel (fable, which needs Fable access),
     remoteControlAtStartup (Remote Control on in every session), agentPushNotifEnabled (push notifications)
     and autoContinueAtUsageLimit (sessions wait out a usage-limit reset and continue).
     ASK me about each one; set only the ones I say yes to.
   - Validate the result as JSON (parse it with node) before saving. List what you changed and what you left alone.

6. MCP servers (user scope) from claude/mcp-servers.json, skipping any that `claude mcp list` already shows:
     claude mcp add --scope user repomix -- npx -y repomix --mcp
     claude mcp add --scope user ast-grep -- uvx --from git+https://github.com/ast-grep/ast-grep-mcp ast-grep-server
   ast-grep needs `uv` (https://docs.astral.sh/uv/) and the `ast-grep` CLI (`npm i -g @ast-grep/cli`). If either is
   missing, tell me the install command instead of guessing.

7. Plugins: if `claude plugin marketplace list` does not show claude-plugins-official, add it first
   (`claude plugin marketplace add anthropics/claude-plugins-official`). Then, for each plugin in the fragment's
   enabledPlugins, run `claude plugin install <name>@claude-plugins-official`, skipping ones `claude plugin list`
   already shows. If the CLI refuses, give me the matching `/plugin install ...` commands to type myself.
   pyright-lsp needs `pyright` (`npm i -g pyright`) and typescript-lsp needs `typescript-language-server`
   (`npm i -g typescript typescript-language-server`). Tell me if they are missing.

8. Platform note: the handoff-launch skill's `--mode window` opens Windows Terminal/PowerShell and is Windows-only
   (the launcher refuses it elsewhere; `--mode bg` works everywhere). If I am on macOS or Linux, tell me that, and
   offer (do not do it unprompted) to adapt the window launcher, e.g. to osascript + Terminal or to tmux.

9. Verify and report:
   - `echo {} | node "CONFIG/hooks/goal-gate.mjs"` exits 0 with no output.
   - `echo {} | node "CONFIG/hooks/coord.mjs" post-tool` exits 0 with no output, and
     `node "CONFIG/hooks/coord.mjs" tick --dry-run` prints `tick: nothing to do` (or the lines of what it would do).
     coord.mjs is not added to settings.json: launch.mjs passes it to each session it starts.
   - The goal gate must find this session's scratchpad. Your session id is the name of your scratchpad's parent folder.
     Your transcript is the file matching CONFIG/projects/*/<session id>.jsonl; find it with a file search, do not
     build its path from the scratchpad path. Write a GOAL.md containing `- [ ] test` into YOUR OWN session
     scratchpad directory, then pipe `{"session_id":"<session id>","transcript_path":"<transcript path>"}` to the
     hook, writing every path with forward slashes (a backslash breaks the JSON).
     It must print JSON with "decision":"block". Delete that GOAL.md and the .goal-gate-*.json file
     afterwards. If it does not block, report the scratchpad path the hook expected
     (<os tmpdir>/claude/<project key>/<session id>/scratchpad) next to the real one. That means the gate would be
     silently off on this OS.
   - `node "CONFIG/skills/handoff-launch/launch.mjs" status --group none` prints a line starting `members=0`.
   - settings.json parses; list the agents, skills and MCP servers now installed.
   - Tell me to RESTART Claude Code so the new agents, skills, hook and settings load. A running session never picks up
     newly added skills. After the restart, typing `/` lists the new skills, and dispatches can use subagent types
     worker-low … worker-max and explorer. Quick check after the restart: ask Claude to invoke the `effort-low`
     skill and quote the line the skill returned.
     It should read "Effort is now **low** (`low` in effect) until this turn ends."
   Finally delete the temp clone.
````

After the restart, try it: ask Claude for any multi-step task. It should keep a checklist and write a `GOAL.md`
in its scratchpad, and size each subagent with `worker-*`/`explorer` types. When a session gets long, it should hand
off to a fresh session with `handoff-launch`.
