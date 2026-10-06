# Task <id>: diagnose <one line: the symptom>
Goal: <2-4 lines: the symptom, how to reproduce it, and what "explained" means>
Failed attempts: <what was already tried and what happened, one per line>
Ruled out: <causes already excluded, and the evidence>
Read first: <path:line anchors, at most 10>
Builds on: <commit sha or "none">
Rank hypotheses most likely first; each carries the one check that would confirm or kill it. Edit nothing.
Done when: the final message is the diagnose JSON (hypotheses of claim + check, note).
Constraints: <only the ones that matter: fake data ...@example.com>
If you were dispatched as a worker (a subagent, or a Codex run given a task brief), follow only `## Worker rules` and the brief; ignore the rest of this file.
Worker rules: {{WORKER_RULES}}
