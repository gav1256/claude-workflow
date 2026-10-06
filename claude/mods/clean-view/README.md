# clean-view

A Claude Code mod that makes Claude Code calm and friendly for people who are not technical. It does two things in one plugin:

- **Clean View.** While Claude works, the tool calls, file changes and command output are hidden. One simple checklist card sits above the prompt, so you can always see the plan, what is happening now and how far along it is.
- **Sessions.** A Session Viewer button under the prompt opens a small panel that lists your running sessions: name, model and effort, a progress meter, what each one is doing, and a dot when one is waiting for you.

Both draw in one look: a rounded card, gradient title, segmented meters. Two themes ship with it, Clean View Dark (pink on navy) and Warm (soft orange and amber). All colours except the gradients follow your theme, so the card is pink on Clean View Dark and orange on Warm.

```
╭──────────────────────────────────────────────────────────────╮
│ ✧ Build my landing page                                      │
│ Step 2 of 4                                                  │
│ ✓ Read your brand notes            ██████████   Done         │
│ ● Build the pricing section        ▒▓█▓█        Working      │
│ ○ Add the contact form                          Next         │
│ ○ Polish the footer                             Up next      │
╰──────────────────────────────────────────────────────────────╯
                          [ ● Clean View: ON ]  s: ◆ Sessions 3 · 1 waiting
```

The title is drawn word by word in a gradient (orange, pink, violet, blue). The current step's dot is magenta, its meter is five moving blocks (or a fill to the percent Claude reports), and its word is **Working**. Done steps have a green check and a full green bar. Steps still to come have a hollow dot; the first says **Next**, the others **Up next**.

## The checklist card

The first line says what the job is (2 to 6 plain words, worked out from your message on your own machine; no model is called for it). The card changes with what is going on:

| State | Border | Title line |
|---|---|---|
| Working | magenta | `✧` and the job name |
| Needs you | theme warning | a highlighted **Needs you** badge and the reason, such as "Claude needs your OK to continue". The current step shows ‖ instead of ● |
| Stuck | theme error | ⚠ Stuck: the reason in one plain sentence |
| Stopped | dim | ■ Stopped · job name · you pressed Esc |
| Done | green | a green ` ✓ All done ` badge, the job name, and `took 2m 14s` at the right. Under it: `4 of 4 steps`, a full-width segmented bar and `100%`; every step reads **Done**. After 5 seconds it shrinks to the one title line |

Stuck covers: you said no to a permission ("you said no to a step, so Claude paused"), three failed tool calls in a row ("a step keeps failing, Claude is trying another way"), and API errors, each as one calm sentence (usage limit, servers busy, chat too long: type /compact, internet dropped, signed out: type /login). A refusal says "Claude couldn't help with that request". A success clears Stuck.

On a narrow terminal the meter shrinks to 5 cells and the step name gives way; the status word is always kept.

## How Clean View works

- Two tools are added for Claude: `plan_steps` (lay out every step of the job, 2 to 8 short names, first thing for every request) and `report_progress` (the step's name and a percent; at 100 the step is checked off and the next one starts). While Clean View is on, a short section is added to the system prompt that tells Claude to use them, in plain English, with no file names, paths, commands or code in a step name. The tools keep the names `mcp__clean-view__plan_steps` and `mcp__clean-view__report_progress`.
- Until a plan exists, every other tool is refused with a message telling Claude to call `plan_steps` first. ToolSearch, TodoWrite, TaskCreate, TaskUpdate and AskUserQuestion always pass. Only the main agent is gated; subagents are never refused.
- If Claude uses its own to-do list (TodoWrite, or TaskCreate and TaskUpdate), that list becomes the checklist.
- Permission prompts and questions switch the card to Needs you. It clears when the call finishes, or when you reply.

### What is hidden, and what is not

While Clean View is on, the rows for Read, Edit, MultiEdit, Write, NotebookEdit, Bash, PowerShell, Grep, Glob, LSP, WebFetch, WebSearch, TodoWrite, the Task tools, Agent, ToolSearch, the two tools above and other MCP tools are hidden, and so is the "run in background" hint under a running call. Claude's written replies stay.

Always shown, as the engine draws them: calls that failed or that you interrupted, a result that is only text (a refusal), questions to you, plan mode and its approval, messages and files sent to you, goal proposals, sign-in offers for MCP servers, and any tool whose name starts with Suggest, Offer or Show.

### Turn it on and off

It starts on, and the choice is saved between sessions.

- Press `[ ● Clean View: ON ]` in the dim controls row under the card. A toast says what it is now.
  - In the fullscreen terminal you can click it.
  - Anywhere else press `Ctrl+X` then `Tab` to move the keyboard to the band. With the band focused, the letter `c` presses it. The button has no bare-key shortcut from the prompt, because a bare digit would swallow the first number you type.
- Or type `/simple on` or `/simple off`. `/simple` alone flips it.

Turning it off ends the current job: every hidden row comes back, the plan gate and the system prompt section are off, and only the controls row stays. The choice holds for the session even if it cannot be saved.

## Sessions

### The Session Viewer button

`◇ Session Viewer · 3` sits at the bottom left, under the prompt, always. When a session waits for you it adds ` · 1 waiting` in the warning colour. Pressing it opens the panel, or closes it. It follows the lock: while the panel is locked open a press does not close it and a toast says "Sessions pane is locked". A press opens the panel at any width.

- Click it. A click works only in the fullscreen terminal.
- The keyboard path is the dim controls row above the prompt: `Ctrl+X` then `Tab` to focus the band, then `s` (or `Tab` to `s: ◆ Sessions 3 · 1 waiting` and `Enter`).
- `/sessions` always works.

The controls row in the band yields to a survey (the band draws nothing of its own while one is open); the button under the prompt stays.

### The panel

```
S E S S I O N S ────────────────────────────────────────────────
● * cw-batchB      opus·high      ███████░░░ 7/10   Working
● property         sonnet·low                       Waiting
○ docs             opus·low       ██████████ 3/3    Done
Lock [ On | Off ]  Close
```

A thin rule under spaced capitals, then one row per session: a dot, the name (bold, and marked `*`, for this session), model and effort dimmed, a segmented meter with `done/total`, and a status word.

- Dot: red for a permission dialog, yellow for a question, magenta while busy, hollow and dim when idle.
- Status: **Working** (pink), **Waiting** (warning), **Asking** (warning), **Idle** (dim), **Done** (green, once x of x is complete).
- The meter is pink while it goes on and green when complete. Its source, in order:
  1. This session's own checklist (the card above) once it has a plan. For another session, the done/total, the name of the step in progress and its percent that session published. With Clean View off, this session follows its own to-do list (TodoWrite, TaskCreate and TaskUpdate in the main loop; a subagent's calls are not counted).
  2. The `- [x]` / `- [ ]` count of the session's `GOAL.md`.
  3. Nothing: the cell stays empty.
- At a narrow width the meter shrinks to 5 cells, then goes, and only then the model and effort column goes.
- The footer has `Lock [ On | Off ]` (the selected half is filled; hotkey `l`) and `Close` (hotkey `x`). While locked, Close is refused and says so.

### Commands

- `/sessions` opens the panel, or closes it.
- `/sessions lock` keeps it open. It reopens when you start a session. Closing it by hand is refused.
- `/sessions unlock` lets you close it again.
- `/sessions theme` offers Clean View Dark again, `/sessions theme dark` the same, `/sessions theme warm` the Warm theme (see below).

The lock is saved between sessions.

### The dot

- Red `●`: a permission dialog is open.
- Yellow `●`: the session asked a question, or its last turn ended with one.
- Dim `○`: nothing is waiting.

## Themes

The mod ships two custom themes in `themes/`. Claude Code finds them by their folder, no manifest key is needed. The card and the panel draw with theme colours (`claude` for the border, the Working word and titles, `success` for done, `subtle` for tracks and rules, `text` for names, `inactive` for dim text, `inverseText` on badges), so on any theme they follow that theme. Only the gradient of the title and the meters is fixed.

- **Clean View Dark** (`themes/clean-view.json`): a dark theme with pink as the accent, light grey text, violet-blue suggestions and orange permission pills, made to sit on a navy background.
- **Warm** (`themes/warm.json`): a dark theme in soft orange and amber.

To use one, run `/theme` and pick **Clean View Dark** or **Warm**, or run `/sessions theme` (Clean View Dark) or `/sessions theme warm`. `/sessions theme dark` is the same as `/sessions theme`.

**The terminal background is not part of a theme.** A theme colours Claude Code's own text and boxes; the background behind them is your terminal's. For the full Clean View Dark look, set your terminal profile's background to about `#1f2430`. On another background the theme still works, only the navy is yours to set.

The first time a session with a screen starts (never a headless run) the mod also offers Clean View Dark, once, but only if your theme is still the default `dark` (or unset): it looks for the theme row of the `/config` menu and, if it finds this mod's option and the engine accepts the change, sets it and says so in a toast. If you picked another theme it never replaces it, it only toasts the hint. If the engine refuses it toasts "Pick 'Clean View Dark' in /theme for the clean look". It never tries again on its own, and never offers it to someone who already got the earlier Warm offer (the same "offered" flag). `/sessions theme [dark|warm]` tries on demand and then sets that theme whatever theme you have.

## Coming from sessions-pane

This plugin replaces the `sessions-pane` and `progress-bars` mods. Remove them from `CLAUDE_CODE_PLUGIN_DIRS` (and delete their folders) when you add this one. On the first start with a screen, the saved lock and the "theme already offered" flag of sessions-pane are carried over once. A plugin cannot read another plugin's `$.store`, so the mod reads the old plugin's file in the store folder (`<config dir>/plugins/store/sessions-pane_*.json`, the newest if there are several) with `$.fs`. If that file cannot be found or read, the lock starts off, and the theme is marked as offered when Warm or Clean View Dark is already the one in use. The Clean View setting needs no move: it was always saved under this plugin's name.

## Install on another computer

Copy this folder to the other computer, then pick one.

- Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
- Or start Claude Code with `claude --plugin-dir <this folder>`.

Saving a file in the folder reloads the mod in a running session.

## Limits

- The permission dialog stays as the engine draws it, in full. A mod cannot hide it.
- A click on a button is reported only in the fullscreen terminal. Elsewhere use `Ctrl+X` then `Tab`, then the hotkey (`c`, `s`, `l`, `x`) or `Enter`.
- It is for interactive sessions. In a headless run (`claude -p`, the SDK) there is no band, so it adds no prompt section and refuses no tool, publishes nothing and reads nothing of the old store. The gate is also open if its two tools could not be registered.
- Claude has to follow the plan section. If it finishes with steps still unchecked, the card says "Needs you: Claude is waiting for your reply".
- The system prompt section also reaches subagents; it tells them to ignore it, and a subagent's `plan_steps` call is answered but changes nothing.
- A slash command's turn, and a skill's (the mod sees the command just before the turn), has no job name and no checklist, and asks for no plan: its tools are not refused.
- Other mods draw in the same band: their rows stay above the card.
- The engine picks where the panel sits. It docks beside the transcript in a wide full-screen terminal and otherwise sits above the prompt. A panel opened without you asking only appears from 144 columns; `/sessions` or the button open it at any width.
- The red dot stays on while an approved tool is still running. The engine gives no event for "the dialog was answered", so it clears when the tool call ends.
- Your own session is always accurate. Other sessions are accurate only if they run this mod (or the older sessions-pane, whose records this one still reads and writes in the same shape). Sessions started by the launcher are also read from its registry, and they show a wait only when the launcher's hook records one.
- Without a config directory (none of `CLAUDE_CONFIG_DIR`, `USERPROFILE`, `HOME` is set) the sessions part reads and writes nothing.

## What the sessions part reads and writes

The config directory is `CLAUDE_CONFIG_DIR`, or else your home directory plus `/.claude`.

It reads, never more than 4 MiB per file:

- `skills/handoff-launch/sessions.jsonl`, the launcher's session registry.
- `state/coord/sessions/<session id>.json`, for a pending permission prompt and the path of the goal file.
- The goal file (`GOAL.md`), only to count `- [x]` against all checklist items.
- `state/coord/pane/*.json`, what the other sessions published.
- File times (not contents) of `projects/<project>/<session id>.jsonl`, to tell if a session is still alive.
- Once, at the first start with a screen: the folder `plugins/store` and the old sessions-pane store file in it (see above).

It writes one file: `state/coord/pane/<session id>.json`. It holds the session id, name, folder, model, effort, whether it waits and on what, whether it is busy, its task progress (`done`, `total`, the name of the task in progress) and a timestamp. It is rewritten every few seconds and marked stale when the session ends.

It never calls the model and never deletes anything. Old pane files are left behind, and other sessions ignore them once they are stale.

## Development

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

Every function that takes `$` is in `hooks/plugin.tsx`: `claude plugin validate` follows `$` only into a function declared in the same file, and reads atoms only when they are written there, so the hooks both features share (one each of session, turn, tool.call and command.run, in a fixed order) and the band they draw in cannot be split across files. The file has five sections: State, Clean View, Sessions, the shared hooks, and the band. `hooks/register.tsx` calls them in that order.

The logic that needs no `$` is split by feature and tested directly:

- `hooks/model.ts`: what both share (the plugin name, the old-store move's pure parts).
- `hooks/model-clean.ts`: name cleaner, job name, checklist rules, error sentences, which rows hide.
- `hooks/model-sessions.ts` and `hooks/io.ts`: session rows, merge, waiting, layout, the lock, the theme names; the file reads (through a fake in tests).
- `hooks/look.ts`: the card's colours, gradient, meters, columns and status words.
- `hooks/migrate.ts`: the one-time move of the old sessions-pane values.

Tests: `hooks/clean-view.test.ts` (the checklist, the gate, the card), `hooks/sessions.test.ts` (the panel, the buttons, what a session publishes, the theme, the move at start) and `hooks/migrate.test.ts` (the move over fakes). `tests/themes.test.mjs` checks the two theme files are valid JSON with `#rrggbb` colours; a hooks module cannot read files, so run it with `node --test tests/themes.test.mjs`.
