---
description: Manage cc-enhance capabilities (enable providers, login, status, computer bridge)
argument-hint: "status | <provider> <capability> enable|disable | defaults <cap> <provider> | login [provider] [key] | computer <action>"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cc-enhance.mjs" cli $ARGUMENTS`

The output above is the result of `/cc-enhance $ARGUMENTS`. Relay it to the user concisely in their language, without re-running it. If it shows an error or missing credentials, explain the next step (the exact `/cc-enhance …` command to run). Do not call tools unless the user asks.
