---
description: Manage gen_image capability (enable/disable/status per provider)
argument-hint: "<provider> enable|disable|install|uninstall|status | defaults <provider>"
allowed-tools: Bash(node:*)
---

!`set -- $ARGUMENTS; root="${CLAUDE_PLUGIN_ROOT}/dist/cc-enhance.mjs"; if [ -z "$1" ]; then node "$root" cli status; elif [ "$1" = defaults ]; then node "$root" cli defaults gen_image "$2"; else p=$1; shift; node "$root" cli "$p" gen_image "$@"; fi`

The output above is the result of `/cc-enhance:gen_image $ARGUMENTS`. Relay it to the user concisely in their language, without re-running it. If it shows an error or missing credentials, explain the next step (the exact command to run). Do not call tools unless the user asks.
