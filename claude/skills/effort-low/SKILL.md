---
name: effort-low
description: Set reasoning effort to low until this turn ends (mechanical work: commands, copying, formatting, status). See switching-effort.
effort: low
---

Effort is now **low** (`${CLAUDE_EFFORT}` in effect) until this turn ends. Continue the task you were doing; do not restate it.
If the tool `set_effort` (Clean View) is available, call it now with level `low` (auto permission mode otherwise drops this switch; load it with ToolSearch if it is deferred).
Switch call: $ARGUMENTS
