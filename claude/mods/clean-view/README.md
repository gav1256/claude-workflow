# clean-view

A Claude Code mod that makes Claude Code calm and friendly for people who are not technical. While Claude works, the tool calls, file changes and command output are hidden. One simple checklist sits above the prompt, so you can always see the plan, what is happening now and how far along it is.

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

## What you see

The first line says what the job is (2 to 6 plain words, worked out from your message on your own machine; no model is called for it) and how long it has been running. The button at the right of that line is always there, even when nothing is running.

- Done steps have a green check, a dimmed name, a full meter and "Done".
- The current step has a ▶, a bold name and a meter that fills to the percent Claude reports. With no percent yet the meter shows a moving sweep and says "Working".
- Steps still to come are dimmed. The first says "Next", the others say "Up next".

The first line changes with what is going on:

| State | First line |
|---|---|
| Working | Job name · time running |
| Needs you | A highlighted **Needs you** badge and the reason, such as "Claude needs your OK to continue". The current step shows ‖ instead of ▶. |
| Stuck | ⚠ Stuck: the reason in one plain sentence |
| Stopped | ■ Stopped · job name · you pressed Esc |
| Done | ✓ All done · job name · took 2m 14s. After 5 seconds it shrinks to this one line. |

Stuck covers: you said no to a permission ("you said no to a step, so Claude paused"), three failed tool calls in a row ("a step keeps failing, Claude is trying another way"), and API errors, each as one calm sentence (usage limit, servers busy, chat too long: type /compact, internet dropped, signed out: type /login). A refusal says "Claude couldn't help with that request". A success clears Stuck.

## How it works

- Two tools are added for Claude: `plan_steps` (lay out every step of the job, 2 to 8 short names, first thing for every request) and `report_progress` (the step's name and a percent; at 100 the step is checked off and the next one starts). While Clean View is on, a short section is added to the system prompt that tells Claude to use them, in plain English, with no file names, paths, commands or code in a step name.
- Until a plan exists, every other tool is refused with a message telling Claude to call `plan_steps` first. ToolSearch, TodoWrite, TaskCreate, TaskUpdate and AskUserQuestion always pass. Only the main agent is gated; subagents are never refused.
- If Claude uses its own to-do list (TodoWrite, or TaskCreate and TaskUpdate), that list becomes the checklist.
- Permission prompts and questions switch the first line to Needs you. It clears when the call finishes, or when you reply.

## What is hidden, and what is not

While Clean View is on, the rows for Read, Edit, MultiEdit, Write, NotebookEdit, Bash, PowerShell, Grep, Glob, LSP, WebFetch, WebSearch, TodoWrite, the Task tools, Agent, ToolSearch, the two tools above and other MCP tools are hidden, and so is the "run in background" hint under a running call. Claude's written replies stay.

Always shown, as the engine draws them: calls that failed or that you interrupted, a result that is only text (a refusal), questions to you, plan mode and its approval, messages and files sent to you, goal proposals, sign-in offers for MCP servers, and any tool whose name starts with Suggest, Offer or Show.

## Turn it on and off

It starts on, and the choice is saved between sessions.

- Press the button at the right of the first line. A toast says what it is now.
  - In the fullscreen terminal you can click it.
  - Anywhere else press `Ctrl+X` then `Tab` to move the keyboard to the band. With the band focused, the letter `c` presses the button. Or `Tab` to the button and press `Enter` (Ctrl+X Tab lands on the first thing in the band, which may be another mod's button). The button has no bare-key shortcut from the prompt, because a bare digit would swallow the first number you type.
- Or type `/simple on` or `/simple off`. `/simple` alone flips it.

Turning it off ends the current job: every hidden row comes back, the plan gate and the system prompt section are off, the rest of the band draws as usual and only the button stays. The choice holds for the session even if it cannot be saved.

## Install on another computer

Copy this folder to the other computer, then pick one.

- Add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.
- Or start Claude Code with `claude --plugin-dir <this folder>`.

Saving a file in the folder reloads the mod in a running session.

## Limits

- The permission dialog stays as the engine draws it, in full. A mod cannot hide it.
- A click on the button is reported only in the fullscreen terminal. Elsewhere use `Ctrl+X` then `Tab`, then `Enter`.
- It is for interactive sessions. In a headless run (`claude -p`, the SDK) there is no band, so it adds no prompt section and refuses no tool. The gate is also open if its two tools could not be registered.
- Claude has to follow the plan section. If it finishes with steps still unchecked, the first line says "Needs you: Claude is waiting for your reply".
- The system prompt section also reaches subagents; it tells them to ignore it, and a subagent's `plan_steps` call is answered but changes nothing.
- A slash command's turn, and a skill's (the mod sees the command just before the turn), has no job name and no checklist, and asks for no plan: its tools are not refused.
- Other mods draw in the same band (the sessions mod adds a Sessions button): their rows stay above the checklist.

## Development

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

The logic that needs no `$` is in `hooks/model.ts` (name cleaner, job name, checklist rules, error sentences, meter). The hooks and the drawing are in `hooks/clean-view.tsx`, called from `hooks/register.tsx`. The tests are in `hooks/clean-view.test.ts`.
