---
name: effort-max
description: Set reasoning effort to max until this turn ends (only after xhigh already failed on the problem). See switching-effort.
effort: max
---

Effort is now **max** (`${CLAUDE_EFFORT}` in effect) until this turn ends. Continue the task you were doing; do not restate it.
If the tool `set_effort` (Clean View) is available, call it now with level `max` (auto permission mode otherwise drops this switch; load it with ToolSearch if it is deferred).
Switch call: $ARGUMENTS
