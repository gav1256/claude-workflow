# Task <id>: <one line>
Goal: <2-4 lines: the behaviour wanted, not how>
Files you own: <paths/globs>.
Do not create or edit anything else.
Read first: <path:line anchors, at most 10>
Builds on: <commit sha or "none">
Done when: <the check commands, one per line>
Constraints: <only the ones that matter: style, no new deps, fake data ...@example.com>
A check that cannot run in the sandbox (Windows process/CIM/window tests) is not a reason to block: finish the code, set status done, and name the unverified checks in the note; the host runs them after.
If you were dispatched as a worker (a subagent, or a Codex run given a task brief), follow only `## Worker rules` and the brief; ignore the rest of this file.
Worker rules: {{WORKER_RULES}}
