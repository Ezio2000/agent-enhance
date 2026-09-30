---
description: Manage the native computer runtime (status/reset)
argument-hint: "status | reset"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cc-enhance.mjs" cli computer $ARGUMENTS`

The output above is the result of `/cc-enhance:manage_computer $ARGUMENTS`. Relay it to the user concisely in their language, without re-running it. If it shows an error, explain the next step (the exact command to run). Do not call tools unless the user asks.
