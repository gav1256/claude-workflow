# Task <id>: review <one line: what is under review>
Goal: <2-4 lines: what the change should do and what to look for, not how to fix it>
Review input: .codex-tmp/<run-id>/review.patch (sha256 <hash>)
Read first: <path:line anchors, at most 10>
Builds on: <commit sha or "none">
Review the patch above, not the rest of the tree. Report each finding with severity, file, line_start/line_end, a concrete failure scenario in body and a recommendation. Edit nothing.
Done when: the final message is the review JSON (verdict, summary, findings, next_steps).
Constraints: <only the ones that matter: fake data ...@example.com>
If you were dispatched as a worker (a subagent, or a Codex run given a task brief), follow only `## Worker rules` and the brief; ignore the rest of this file.
Worker rules: {{WORKER_RULES}}
