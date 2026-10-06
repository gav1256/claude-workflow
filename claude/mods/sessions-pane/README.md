# sessions-pane

A Claude Code mod. It adds a small pane that lists your running sessions.

Each row shows the session name, its model and effort, what it is doing, and a progress meter such as `███████░░░ 7/10`. A dot on the left tells you when a session is waiting for you. The current session is marked with `*`. A one-line summary such as `5 sessions · 2 waiting` also sits under the prompt, so you still see it when the pane is closed.

## The Sessions button

A small button sits in the band above the prompt all the time and draws as `s: ◆ Sessions 3 · 1 waiting` (the `s` is its hotkey; just `s: ◆ Sessions` while the count is unknown). Pressing it opens the pane, or closes it. It follows the lock: while the pane is locked open a press does not close it and a toast says "Sessions pane is locked". A press opens the pane at any width.

Three ways to press it:

- Click it. This works only in the fullscreen terminal.
- Press `Ctrl+X` then `Tab` to focus the band, then `Enter`. With the band focused, the hotkey `s` presses it too.
- It has no bare-key shortcut from the prompt: a letter hotkey fires only while the band holds the focus, and a bare digit is left to Clean View and the surveys. `/sessions` always works.

The button yields while a survey is open, and it draws below whatever else the band shows (Clean View's checklist stays).

## Progress meters

The meter in each row is 10 cells (`███████░░░ 7/10`): amber cells on a muted track. Its source, in order:

1. The session's own live task list, published as `done/total`, the name of the task in progress and its percent in its pane file. If Clean View is loaded, its checklist (read from `$.state`, plugin `clean-view`, key `checklist`, once it has a plan) is the first source: it already follows `plan_steps`, `report_progress`, `TodoWrite` and `TaskCreate`, and the mod needs no setting for it (without Clean View that state is simply never written). Otherwise the mod follows `TodoWrite`, `TaskCreate` / `TaskUpdate` (and `plan_steps` / `report_progress`, if it happens to see them) in the main loop; a subagent's calls are not counted. A list with every task done hands the meter to the GOAL.md count, when there is one. The label stays `done/total`; the fill counts the active step's percent too, so 2 of 4 steps done and the third at 50% fills 6 of 10 cells.
2. The `- [x]` / `- [ ]` count of the session's `GOAL.md`.
3. Nothing: the cell stays empty.

When the pane is narrow the meter shrinks to 5 cells. Narrower still it goes, and only then does the model and effort column go.

## Install

Pick one.

- Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
- Or start Claude Code with `claude --plugin-dir <this folder>`.

Saving a file in the folder reloads the mod in a running session.

## Commands

- `/sessions` opens the pane, or closes it.
- `/sessions lock` keeps the pane open. It reopens when you start a session. Closing it by hand is refused.
- `/sessions unlock` lets you close it again.
- `/sessions theme` offers the Warm theme again (see below).
- The pane has a Lock / Unlock button too. Its hotkey is `l` while the pane has focus.

The lock is saved between sessions.

## Warm theme

The mod ships a custom theme, `themes/warm.json`: a dark theme in soft orange and amber (`claude #d97757`, borders and suggestions `#e0a050`, text `#f2e8dc`). Claude Code finds it by its folder, no manifest key is needed. The pane draws with theme colours (`claude` for the title, `suggestion` for the meters, `subtle` for the track, `text` for names, `inactive` for dim text), so on any theme it follows that theme and on Warm it is soft orange and amber. The waiting dots stay on your theme's red and yellow.

To use it, run `/theme` and pick **Warm**. The first time a session with a screen starts (never a headless run) the mod also tries to switch for you, once, but only if your theme is still the default `dark` (or unset): it looks for the theme row of the `/config` menu and, if it finds this mod's Warm option and the engine accepts the change, sets it and says so in a toast. If you picked another theme it never replaces it, it only toasts the hint. If the engine refuses (the theme may be changeable only from its own dialog) it toasts "Pick 'Warm' in /theme for the warm look". It never tries again on its own; `/sessions theme` tries once more on demand, and then sets Warm whatever theme you have.

## The dot

- Red `●`: a permission dialog is open.
- Yellow `●`: the session asked a question, or its last turn ended with one.
- Dim `○`: nothing is waiting.

## Limits

- The engine picks where the pane sits. It docks beside the transcript in a wide full-screen terminal and otherwise sits above the prompt. It is not bottom-right, and the mod cannot change that.
- A pane opened without you asking only appears from 144 columns. Use `/sessions` to open it at any width.
- No bare key opens the pane from the prompt. Use the button, `/sessions`, or `s` with the band focused.
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

It writes one file: `state/coord/pane/<session id>.json`. It holds the session id, name, folder, model, effort, whether it waits and on what, whether it is busy, its task progress (`done`, `total`, the name of the task in progress) and a timestamp. It is rewritten every few seconds and marked stale when the session ends.

It never calls the model and never deletes anything. Old pane files are left behind, and other sessions ignore them once they are stale.

## Development

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

The logic that needs no `$` is in `hooks/model.ts`. File reads are in `hooks/io.ts`. The hooks and the drawing are in `hooks/register.tsx`.
