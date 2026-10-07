---
name: effort-medium
description: Set reasoning effort to medium until this turn ends (routine edits, simple reviews, known fixes). See switching-effort.
effort: medium
---

Effort is now **medium** (`${CLAUDE_EFFORT}` in effect) until this turn ends. Continue the task you were doing; do not restate it.
If the tool `set_effort` (Clean View) is available, call it now with level `medium` (auto permission mode otherwise drops this switch; load it with ToolSearch if it is deferred).
Switch call: $ARGUMENTS
