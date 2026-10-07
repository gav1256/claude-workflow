---
name: effort-xhigh
description: Set reasoning effort to xhigh until this turn ends (only when the solution space is very wide AND a wrong technical call is highly expensive). See switching-effort.
effort: xhigh
---

Effort is now **xhigh** (`${CLAUDE_EFFORT}` in effect) until this turn ends. Continue the task you were doing; do not restate it.
If the tool `set_effort` (Clean View) is available, call it now with level `xhigh` (auto permission mode otherwise drops this switch; load it with ToolSearch if it is deferred).
Switch call: $ARGUMENTS
