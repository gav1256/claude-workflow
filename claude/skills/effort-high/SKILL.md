---
name: effort-high
description: Set reasoning effort to high until this turn ends (planning, debugging, non-trivial code). See switching-effort.
effort: high
---

Effort is now **high** (`${CLAUDE_EFFORT}` in effect) until this turn ends. Continue the task you were doing; do not restate it.
If the tool `set_effort` (Clean View) is available, call it now with level `high` (auto permission mode otherwise drops this switch; load it with ToolSearch if it is deferred).
Switch call: $ARGUMENTS
