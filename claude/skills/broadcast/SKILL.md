---
name: broadcast
description: Use when the user wants to tell every running Claude Code session something at once - pause all sessions (now, for 30m, or until HH:MM), resume them ("resume from before Shabbat / Yom Tov", "resume from pre-shabbos", "resume after chag", "before shabbat"), reopen the sessions a pause closed, or relay any other message to every peer session ("/broadcast pause 30m", "tell all sessions to ...").
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

- **`usage-pause off|on`**. Run `node "COORD" usage-pause off|on` with the requested state and report its line. Send no broadcast; this switches only usage pauses; lanes paused for usage resume as when the pause lifts. B1 pacing, manual and battery pauses stay unchanged.
- **`pause [30m | 2h | until HH:MM]`** (nothing after it: no end). Run `node "COORD" pause <args>` first. It writes the
  manual pause source and prints a `Broadcast:` line. Send that line's text, word for word, to every peer.
  A timed pause needs no reminder: its `until` expires on its own and the coordinator's watcher resumes the lanes
  (except a pause spanning Shabbat/Yom Tov: it waits for `/broadcast resume` after nightfall). CronCreate one-shots
  fire only while this session is open and idle, so they are not used.
- **`resume`**. Run `node "COORD" resume`. It removes the manual pause (and an old `pause.json`) and wakes a tick that
  relaunches the lanes the pause closed. If it prints `still paused by: ...`, work is NOT resumed: send NO resume
  message to any peer, and tell the user which source still holds. For battery or usage, the covered lanes stay paused
  until that source lifts; for Shabbat/Yom Tov, run `/broadcast resume` again after nightfall: nightfall lifts nothing
  by itself. After a Shabbat/Yom Tov, the lanes relaunch on this command, subject to remaining sources and the
  tick's usual order and cap. If it prints `Shabbat/Yom Tov is still on`, send NO resume message to any peer, tell the
  user to run `/broadcast resume` again after nightfall, and stop here (this also applies during the lead hour).
  Only when no `still paused by:` line appears, it prints a `Broadcast:` line: send that text to every peer.
  Whenever `Shabbat/Yom Tov is still on` is absent, even if `still paused by: ...` remains, read `<coord>/paused.json`
  and the newest `<coord>/paused-*.json` if present, as `restart` does. Print the hand-opened rows of both with
  `"closed": false`, once per `session_id`: `claude --resume <session_id> -n <name>` and its folder (`cwd`). If another
  source remains, tell the user the covered sessions stay paused until that source lifts. The user starts those
  sessions. After an off interval this printout is their only channel: the tick raises no alert.
- **`restart`**: reopen everything the pause closed. Run `node "COORD" resume`, then `node "COORD" tick` in the
  foreground (if `resume` printed `still paused by: ...`, send no resume message and tell the user which source still
  holds: the tick holds back only the lanes a remaining source covers and relaunches the others; it relaunches up to
  three lanes per tick, high priority first, under the coordinator's lock; the watcher or the next tick takes the
  rest), and show its lines. If it prints
  `tick: another tick holds tick.lock - skipped`, a tick is already relaunching them: wait a minute and run
  `node "COORD" tick` again. (By hand, after a reboot with no tick running, `node "LAUNCH" resume --paused --all` does the same in
  one go; never run it in parallel with the tick.)
  If `resume` prints `Shabbat/Yom Tov is still on`, send no resume message, tell the user to run `/broadcast resume`
  again after nightfall, and print no hand-opened resume commands. Otherwise read `<coord>/paused.json` and the newest
  `<coord>/paused-*.json` if present: print the hand-opened rows of both with `"closed": false`, once per `session_id`,
  as `claude --resume <session_id> -n <name>` and the folder (`cwd`) to run it in, even if another source remains.
  If another source remains, tell the user the covered sessions stay paused until that source lifts. You never start
  those sessions yourself: the user does.
- **Anything else** is relayed verbatim to every peer.

## 3. Send and report
For each peer, `SendMessage` with the text. Then report to the user in one short list: who received it, who did not
(and the error), and the coordinator's own lines from step 2. Never send to yourself. A pause applies to ALL sessions (the manual source has scope all): if the user
named a session as an exception, the pause itself cannot honour it - tell the user so, rather than only skipping
that session's message.

A command that prints nothing, or exits non-zero, has failed: report it to the user with its output and exit code,
and never say "done" for it (and do not broadcast a pause or resume whose command failed).

## Notes
- Paused lanes end their turns on their own (their Agent dispatches are denied with the pause text, and their Stop
  records `{paused}` in the launcher registry); the coordinator closes them and relaunches them when the pause ends,
  except after Shabbat/Yom Tov: nightfall resumes nothing; the user runs `/broadcast resume`.
  Hand-opened sessions are never closed; they are listed for `claude --resume`.
- Shabbat mode is on by default: `node "COORD" shabbos on|off|status` controls the global switch. It pauses all
  sessions from the lead hour through the off interval. See handoff-launch's `coordinator.md`, "Shabbat mode".
- Check the state any time: `node "LAUNCH" status --group <id>` (`paused (<reason>, since HH:MM)` per lane) or
  `node "LAUNCH" sessions` (a `pace:` header line when the usage pace is known).
- Large-org variant: a fleet scheduler drains work on a quota or power event; this skill is for one machine.
