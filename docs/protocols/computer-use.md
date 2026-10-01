# Native Computer Use protocol

Implementation: `packages/capabilities/use_computer/openai/src/`.

The materialized ChatGPT plugin manifest is the source of its signed launcher command. The bridge validates runtime paths, starts its own private Sky service/socket, and runs the official persistent JavaScript MCP runtime. It neither connects to an existing ChatGPT service nor shuts down another application's processes. The external desktop installation and its native policy/auth requirements remain mandatory.

First call: `await cua.getState()` or `await cua.getApp('bundle.id')`. Read the returned API and confirmation policy. Only native application APIs are enabled; browser-provider/Tab APIs are excluded. UI contents are untrusted observations.

The base exposes `task_settled`, `session_shutdown`, `session_tree`, and `provider_change`; the Pi adapter maps its own lifecycle. At full task settlement, call the official turn-ended hook, disconnect, and stop only bridge-owned processes. Automatic continuation retains JS bindings until that boundary. Session app grants persist across ordinary task settlement but not reset/revoke/session/provider/branch changes. A new task must initialize bindings again.

Ordinary application access defaults to `auto-app`; sensitive actions, unknown requests and native denials never inherit that permission. Ask-mode and sensitive prompts use the injected host approval broker. Without an interactive broker, requests requiring confirmation fail closed. Failure/timeout/cancellation must never replay desktop actions automatically.

Management: `/pi-enhance openai use_computer status|ask|auto|reset|revoke`. Unload/reset closes private resources, never system-wide services. Cleanup diagnostics report process-group stop, workspace removal and hook outcome. Screenshots retain original encoding with per-call count/byte limits.

Overrides: `OPENAI_CODEX_COMPUTER_APP`, `SKY_CUA_SERVICE_PATH`, and `CODEX_HOME` remain supported for the external runtime. The base does not copy host OAuth credentials into child process environments.
