# sessions-pane

A Claude Code mod. It adds a small pane that lists your running sessions.

Each row shows the session name, its model and effort, what it is doing, and its goal progress (`done/total`). A dot on the left tells you when a session is waiting for you. The current session is marked with `*`. A one-line summary such as `5 sessions · 2 waiting` also sits under the prompt, so you still see it when the pane is closed.

## Install

Pick one.

- Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
- Or start Claude Code with `claude --plugin-dir <this folder>`.

Saving a file in the folder reloads the mod in a running session.

## Commands

- `/sessions` opens the pane, or closes it.
- `/sessions lock` keeps the pane open. It reopens when you start a session. Closing it by hand is refused.
- `/sessions unlock` lets you close it again.
- The pane has a Lock / Unlock button too. Its hotkey is `l` while the pane has focus.

The lock is saved between sessions.

## The dot

- Red `●`: a permission dialog is open.
- Yellow `●`: the session asked a question, or its last turn ended with one.
- Dim `○`: nothing is waiting.

## Limits

- The engine picks where the pane sits. It docks beside the transcript in a wide full-screen terminal and otherwise sits above the prompt. It is not bottom-right, and the mod cannot change that.
- A pane opened without you asking only appears from 144 columns. Use `/sessions` to open it at any width.
- No hotkey can open the pane while it is closed. Use `/sessions`.
- The red dot stays on while an approved tool is still running. The engine gives no event for "the dialog was answered", so it clears when the tool call ends.
- Your own session is always accurate. Other sessions are accurate only if they run this mod. Sessions started by the launcher are also read from its registry, and they show a wait only when the launcher's hook records one.
- Without a config directory (none of `CLAUDE_CONFIG_DIR`, `USERPROFILE`, `HOME` is set) the mod reads and writes nothing. In a plain `claude -p` run it reads and writes nothing.

## What it reads and writes

The config directory is `CLAUDE_CONFIG_DIR`, or else your home directory plus `/.claude`.

It reads, never more than 4 MiB per file:

- `skills/handoff-launch/sessions.jsonl`, the launcher's session registry.
- `state/coord/sessions/<session id>.json`, for a pending permission prompt and the path of the goal file.
- The goal file (`GOAL.md`), only to count `- [x]` against all checklist items.
- `state/coord/pane/*.json`, what the other sessions published.
- File times (not contents) of `projects/<project>/<session id>.jsonl`, to tell if a session is still alive.

It writes one file: `state/coord/pane/<session id>.json`. It holds the session id, name, folder, model, effort, whether it waits and on what, whether it is busy, and a timestamp. It is rewritten every few seconds and marked stale when the session ends.

It never calls the model and never deletes anything. Old pane files are left behind, and other sessions ignore them once they are stale.

## Development

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

The logic that needs no `$` is in `hooks/model.ts`. File reads are in `hooks/io.ts`. The hooks and the drawing are in `hooks/register.tsx`.
