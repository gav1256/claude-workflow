---
name: broadcast
description: Use when the user wants to tell every running Claude Code session something at once - pause all sessions (now, for 30m, or until HH:MM), resume them, reopen the sessions a pause closed, or relay any other message to every peer session ("/broadcast pause 30m", "tell all sessions to ...").
---

# Broadcast

Send one message to every live peer session from this one (the "master"), and drive the one pause protocol of the
handoff-launch coordinator. `<coord>` is `<config>/state/coord`; `<config>` is `CLAUDE_CONFIG_DIR` if set, otherwise
`~/.claude`. `COORD` below is `<config>/hooks/coord.mjs`, `LAUNCH` is `<config>/skills/handoff-launch/launch.mjs`.
Write every path with forward slashes and in double quotes.

## 1. Find the peers
Call `ListAgents`. The peers are every row that is live (interactive or background) and is not this session. Skip
offline Remote Control rows. Keep the list: you report on it at the end.

## 2. The verb
The first word of the user's message picks the verb:

- **`pause [30m | 2h | until HH:MM]`** (nothing after it: no end). Run `node "COORD" pause <args>` first. It writes the
  manual pause source and prints a `Broadcast:` line. Send that line's text, word for word, to every peer.
  A timed pause needs no reminder: its `until` expires on its own and the coordinator's watcher resumes the lanes
  (CronCreate one-shots fire only while this session is open and idle, so they are not used).
- **`resume`**. Run `node "COORD" resume`. It removes the manual pause (and an old `pause.json`) and wakes a tick that
  relaunches the lanes the pause closed. If it prints `still paused by: ...`, tell the user which source still holds
  (a low battery, the usage pace) - only that source ending lifts it. Send every peer: "resume your saved work".
- **`restart`**: reopen everything the pause closed. Run `node "COORD" resume`, then `node "COORD" tick` in the
  foreground (it relaunches up to three lanes, high priority first, under the coordinator's lock; the watcher or the
  next tick takes the rest), and show its lines. If it prints `tick: another tick holds tick.lock - skipped`, a tick is
  already relaunching them: wait a minute and run `node "COORD" tick` again. (By hand, after a reboot with no tick
  running, `node "LAUNCH" resume --paused --all` does the same in one go; never run it in parallel with the tick.)
  Then read `<coord>/paused.json` (or the newest `<coord>/paused-*.json` when it was already archived): for every row
  with `"closed": false` (a session you opened by hand), print `claude --resume <session_id> -n <name>` and the folder
  (`cwd`) to run it in. You never start those sessions yourself: the user does.
- **Anything else** is relayed verbatim to every peer.

## 3. Send and report
For each peer, `SendMessage` with the text. Then report to the user in one short list: who received it, who did not
(and the error), and the coordinator's own lines from step 2. Never send to yourself; never send a pause to a session
the user named as an exception.

A command that prints nothing, or exits non-zero, has failed: report it to the user with its output and exit code,
and never say "done" for it (and do not broadcast a pause or resume whose command failed).

## Notes
- Paused lanes end their turns on their own (their Agent dispatches are denied with the pause text, and their Stop
  records `{paused}` in the launcher registry); the coordinator closes them and relaunches them when the pause ends.
  Hand-opened sessions are never closed; they are listed for `claude --resume`.
- Check the state any time: `node "LAUNCH" status --group <id>` (`paused (<reason>, since HH:MM)` per lane) or
  `node "LAUNCH" sessions` (a `pace:` header line when the usage pace is known).
- Large-org variant: a fleet scheduler drains work on a quota or power event; this skill is for one machine.
