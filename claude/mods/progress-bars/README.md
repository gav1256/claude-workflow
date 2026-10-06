# progress-bars

A Claude Code mod. It hides the code and tool output in the transcript and shows short progress lines instead.

## What it does

- These tools are drawn as one line: Read, Edit, MultiEdit, Write, NotebookEdit, Bash, PowerShell, Grep, Glob, LSP, WebFetch, WebSearch, TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet and Agent. While one runs: `▸ Edit app.ts ░░▒▓`. When it is done: `✓ Edit app.ts`. The target is short: a file's base name, the first words of a shell command (or its description), a search pattern, an agent's description. It never shows a whole command. Every other tool is drawn by the engine as usual: messages and files sent to you, goal proposals, MCP tools, sign-in and install offers, and anything new.
- A finished call has one dim line under it: `+3 −1` for an edit or write, `120 lines` for a read, `done` for a shell command, `7 matches` or `12 files` for a search. A shell line adds the engine's own note on the result when there is one (`done · No matches found`), and ` · stderr` when the command wrote to stderr.
- A long block of code in a reply becomes one line: `[code · ts · 20 lines]`. Prose is untouched. A block is collapsed only when its closing fence is there; an unclosed block (a reply still streaming, a stray fence) stays as it is.
- While the model works, a bar sits above the prompt: `▕████████░░░░▏ 4/7 tasks`. It follows the model's task list (TodoWrite, or TaskCreate and TaskUpdate calls that did not fail). With no task list it shows finished calls out of started calls: `▕██████░░░░░░▏ 6 tool calls`. The count restarts each turn. The task list is kept until the session ends.

## What stays fully visible

- Permission dialogs, and the AskUserQuestion dialog with its row. Questions pop up as usual.
- Plan mode: the plan and its approval.
- Errors, calls you interrupted, and a result that is only text (a refusal or an abort).
- Code blocks the mod does not collapse:
  - a block of 5 lines or fewer;
  - a command, settings or diff block: a block whose language is `sh`, `bash`, `shell`, `console`, `powershell`, `ps1`, `cmd`, `bat`, `zsh`, `fish`, `pwsh`, `ps`, `batch`, `dos`, `shell-session`, `sh-session`, `terminal`, `nu`, `json`, `jsonc`, `yaml`, `yml`, `toml`, `ini`, `env`, `dotenv`, `diff` or `patch`, or any block with a line that starts with `! `.

Only the other closed blocks are collapsed. A fence counts when it is at most three spaces in; a collapsed block keeps its indent, so a list is not split.

## Install

Pick one.

- Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
- Or start Claude Code with `claude --plugin-dir <this folder>`.

Saving a file in the folder reloads the mod in a running session.

## Command

- `/bars` flips it on or off.
- `/bars on`, `/bars off` set it.
- `/bars status` tells you which it is.

It is on by default. The choice is saved between sessions, and a toast says what it is now. When it is off the mod draws nothing and the engine draws everything as usual.

## Limits

- The engine has no progress element, so the bars are text (`█` and `░`).
- ctrl+o does not show the code either. To see it, run `/bars off`.
- The running mark on a row is fixed, not animated.
- A collapsed code block is gone from the screen only. The model and the transcript file keep the full text.
- The summary under a call uses what the tool result carries. A call the engine marks as errored is drawn in full.
- A subagent's tool calls count in neither the bar nor the task list.

## Development

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

The logic that needs no `$` is in `hooks/model.ts`. The hooks and the drawing are in `hooks/register.tsx`. The tests are in `hooks/bars.test.ts`.
