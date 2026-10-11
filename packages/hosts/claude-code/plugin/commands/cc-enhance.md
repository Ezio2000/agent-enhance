---
description: Discover service connections and manage capability preferences
argument-hint: "[status | services | refresh | prefer <capability> [service|auto] | exclude|include <capability> [service] | computer <action> | help]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cc-enhance.mjs" cli $ARGUMENTS`

The output above is the result of `/cc-enhance $ARGUMENTS`. Relay it to the user concisely in their language, without re-running it. Keep capability names, service IDs and commands verbatim; a table is fine for the capability overview. If it shows an error, a missing connection or a choice to make, give the exact `/cc-enhance …` command to run next. Do not call tools unless the user asks.
