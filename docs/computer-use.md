# Computer Use: pi → official node_repl → Sky → macOS

## Scope

This is a local integration with the user's installed official runtime, not an independent reimplementation or redistribution of OpenAI software. It does not call an extra model or consume the pi OAuth token itself, and the control path reads no credentials: the smoke passes with an empty and even a nonexistent CODEX_HOME. Whether the shipped runtime works when the ChatGPT desktop app itself has never been logged in is not verified. UI observations become tool results in the current model conversation. The main model can be any pi provider (cross-channel, like codex_image); the runtime, approvals and prompts do not depend on it. Codex models are trained on the cua API, other models rely on the tool description and first-call API documentation. Other native-runtime services may use the user's existing Codex installation/configuration; the bridge does not claim the entire native stack is offline.

Validated against the local ChatGPT bundle's `@oai/sky` 0.6.26 and `CodexComputerUseIPC-5`. Compatibility is not guaranteed across app updates. Only macOS is enabled; Safari is controlled as a native application, not via browser/CDP integration.

The launch command comes from the plugin manifest the desktop app materializes, not from a hardcoded launcher path, so a renamed launcher is picked up without an extension change. That manifest only exists once the desktop app has run and enabled Computer Use; desktop builds that predate manifest materialization are outside the supported range and fail explicitly.

## Runtime discovery and process lifetime

`runtime.ts` discovers the absolute application bundle from `OPENAI_CODEX_COMPUTER_APP` or `/Applications/ChatGPT.app`, resolves its launch command from the plugin manifest the desktop app materializes (see below), checks the shipped executables and modules, then creates a private temporary working directory with a symlink to shipped node_modules. No project-local executables are discovered. It also resolves the signed Sky service from `SKY_CUA_SERVICE_PATH` or `$CODEX_HOME/computer-use/Codex Computer Use.app` and starts a bridge-owned instance on a private socket inside the app group container.

The child runs the launch command the desktop app itself materializes for `cua_repl` in `$CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use/<version>/.mcp.json`, preferring the `latest` pointer and otherwise the newest valid version directory, and forces computer-only surfaces. Reading the app's own manifest keeps discovery independent of launcher file names, which the desktop app already renamed once (`scripts/launch.mjs` up to 26.903, `@oai/cua-repl/bin/cua-repl.mjs` from 26.908); there is no candidate list and no per-version branch. Only absolute paths inside the application bundle or `CODEX_HOME` are accepted, and the rest of the manifest, including its browser surfaces, is ignored. The manifest's `NODE_REPL_NODE_PATH`, `CUA_REPL_NODE_REPL_PATH`, `NODE_REPL_NODE_MODULE_DIRS`, `CODEX_CLI_PATH` and `SKY_CUA_SERVICE_PATH` are adopted only after the bridge revalidates each path against those roots, so the shipped `node`, `node_repl`, module directories and packaged `codex` stay the fallback rather than a duplicate list. `NODE_REPL_TRUSTED_SERVICES` is set explicitly to the computer surface's Sky service and no longer depends on whatever a launcher happens to default to. A missing or unusable manifest fails with the inspected locations and reasons instead of silently falling back to a hardcoded launcher path. Both sanitized PATHs (node_repl child and Sky service) lead with the bundle's Resources directory: the Sky service resolves the packaged `codex` on PATH and spawns its own `codex app-server` to fetch auth status and the computer-use policy for cua operations; without Resources in the service PATH every call fails with `codex app-server exited before returning a response` (-10005) unless the ChatGPT desktop app happens to be running its shared app-server infrastructure. Before node_repl starts, the bridge spawns the signed `SkyComputerUseService` with a minimal environment and `SKY_CUA_SERVICE_NATIVE_PIPE_PATH` set to a unique `pi-<hex>.sock` in the app group IPC directory, and waits until the socket accepts a probe connection. The shipped `@oai/sky` client prefers that variable, so the runtime connects only to this private instance and never to a ChatGPT-owned or shared service. The private socket name stays under the macOS 104-byte `sun_path` limit. No ChatGPT process is required, contacted, or reused.

No OAuth tokens, inherited `NODE_OPTIONS`, loader-injection environment variables, or safety-disabling switches are forwarded. The bridge does not patch official files, authentication, or macOS permissions.

A single MCP process is created lazily on first call, retained until pi fully settles (including automatic continuation), and reused for JavaScript variables and module initialization. All actor calls are serialized. Requests have bounded timeouts and a 64 MiB framing buffer cap. Disconnects, cancellations, malformed transport responses and timeouts fail pending requests; actions are never replayed automatically.

At `agent_settled`, invoke bounded `turn_ended(Stop, session_id, turn_id)`, then unconditionally disconnect/stop the bridge-owned runtime, stop the bridge-owned Sky service and remove its temporary workspace and private socket, even if the hook succeeds or fails. Preserve only in-memory session app grants. Because the Sky instance and its socket are bridge-owned, stopping it releases the virtual cursor deterministically and does not depend on any shared service or ChatGPT lifecycle. Do not directly synthesize undocumented native IPC. At reset/shutdown, attempt bounded `turn_ended(Interrupt, ...)`, stop the bridge-owned process group and private service, and delete the temporary workspace and socket. Never kill other Codex or Sky processes; the ChatGPT-owned/shared service is never touched. The model must reinitialize all JS variables and app bindings after a settled task or reset. Low-level `agent_end` is deliberately not a cleanup boundary: pi 0.85.1 may automatically retry or compact/continue after that event. Settled cleanup rechecks `ctx.isIdle()` inside the serialized queue to avoid interrupting new work started by another extension. Ordinary cleanup does not revoke app grants or invalidate queued work for the next task. The generation value identifies each process initialization, not the internal kernel state after errors.

Shutdown first ends stdin and gives the owned process group 300 ms to exit gracefully, then escalates to SIGTERM (700 ms) and SIGKILL (500 ms) if needed. Cancellation/transport failures skip the EOF grace period and signal the process group immediately. It checks the process group rather than just the launcher. The private Sky service is stopped with the same bounded SIGTERM/SIGKILL sequence and its socket and lock file are removed. `computer status` exposes the most recent cleanup reason, hook result, generation, elapsed time, exit code/signal, signals sent, observed group termination and workspace removal. These diagnostics contain no code or UI contents. A successful process shutdown does not prove that a native overlay disappeared; verify visually on a real desktop. No shared or ChatGPT-owned Sky service is killed.

Recovery notices are included in model-visible error text and injected before the next user task when the bridge has previously been used and is disconnected/uncertain. A fresh-runtime tool result identifies the new generation. Runtime `isError` results mark JS state as unknown without automatically restarting the process: plain JS errors do not necessarily reset the kernel. Transport failures close the runtime and explicitly invalidate previous bindings. AX indexes must separately be refreshed after UI changes. Recovery never automatically replays UI actions.

## Protocol and UI

MCP stdio uses newline-delimited JSON-RPC 2.0, protocol 2024-11-05. Initialization negotiates elicitation and discovers the actual tool catalog. `js` and `turn_ended` are required. Public `codex_computer` maps code/title/deadline to `js`; it does not expose arbitrary MCP method dispatch. Session/turn/call IDs and current model name are forwarded as turn metadata. They identify this pi run, not a fabricated Codex session history.

Native Sky internals use a different length-prefixed JSON-RPC connection to the bridge-owned signed service. This extension does not directly connect to that socket or emulate its peer authentication; it starts the service and points the shipped `@oai/sky` client at the private socket.

The default `auto-app` policy automatically accepts ordinary Computer Use application-access elicitations, including headless execution. This matches unrestricted pi's normal direct tool execution; it is an explicit extension default, not an inferred YOLO flag or a mapping from `isProjectTrusted()` / `defaultProjectTrust`. Other permission extensions are not automatically detected. Only the existing known native app-access shape qualifies: computer-use connector, known app tool, app-only parameters, session scope, empty form and no sensitive/action-level/strict-review marker. Native organization/safety policy is still enforced before elicitation. An application's `riskLevel` alone does not turn an app-access request into an action-specific confirmation; native policies remain authoritative.

Automatic acceptance records `reason: auto_app_access`, `scope: policy`, and does not populate reusable manual app grants. `computer ask` restores select dialogs (Deny / Allow once / Allow this app for this pi session). Manual grants are exact-app, memory-only and cleared on reset, reload, provider change or session/tree replacement. Sensitive/action-level requests do not inherit automatic or cached grants; unknown empty-form confirmations can only be approved once. Field-bearing forms, URL-auth and strict automatic-review requests fail closed. Without UI, ask mode cannot acquire new grants and sensitive/unknown confirmations are declined. Changing mode or clearing grants cancels queued/in-flight approval dialogs so stale selections cannot recreate revoked grants.

This is not Codex Guardian parity. Do not assume every consequential operation is detected by an elicitation event. The agent must obey the official runtime confirmation policy and get explicit user confirmation before sensitive actions even with an app grant. Do not replace native denies or model restrictions with an alternate desktop-control path.

## Approval diagnostics and capability documentation

The native macOS policy wrapper requests approval on each operation, using the resolved bundle ID. The pi bridge, not Sky, is responsible for automatic ordinary app-access decisions or (in ask mode) reusing its memory-only app grant. Runtime reconnection and turn cleanup retain these grants; explicit reset/revoke and pi-session/provider changes clear them. Runtime startup failure no longer implicitly clears existing grants.

Each call now records bounded approval events in tool details (prompt, decision with once/session scope, cache hit, cancellation), including elapsed milliseconds and app/tool identifiers. Failed calls include diagnostic metadata in their error text, which pi can retain in session history. No approval message text, page contents or credentials are included in these diagnostics. Transport timeouts distinguish a pending approval response from a pending runtime response. This instrumentation cannot recover historical approval choices that were never logged.

The September 7 cloud-game session showed two outer timeouts (35 and 65 seconds) and runtime recreation, but its session records do not establish why a session grant was apparently requested again. Mock regression tests and a Calculator smoke verify grant reuse within a run and after reconnect; they do not prove the cause of that Safari incident.

The first-use documentation is projected to the configured computer-only surface: keep the official Target/App signatures and the complete confirmation policy; remove disabled Browser/Tab declarations and expose only getState/getApp/listApps. Unknown bundled API-document formats fail explicitly rather than silently presenting guessed signatures. Guidance requires bundle IDs, avoids duplicate initial AX reads, and forbids falling back to shell UI control after a failed CUA call.

## Management entry point

Use `/openai-codex-enhance` → **Computer Use** → `status / reset / revoke / ask / auto`. Enter/Space opens the submenu; Enter executes an operation; Esc returns to settings. Opening the menu only reads bridge status, never starts or resets the runtime.

The main command, settings panel, settings presets, total status and management actions all remain available on every provider. Non-Codex settings show n/a and do not modify that provider's requests. Direct forms with argument completion:

```text
/openai-codex-enhance computer status
/openai-codex-enhance computer reset
/openai-codex-enhance computer revoke
/openai-codex-enhance computer ask
/openai-codex-enhance computer auto
```

`computer` alone focuses the management entry in the settings panel. The independent `/codex-computer` command is no longer registered. Runtime operations and grants remain session-only and are not written to the global request preferences file. Reset retains the current approval mode; revoke switches to ask before clearing grants/stopping the runtime, so automatic access does not silently undo revocation. Ask/auto also clear grants and stop the runtime before lazy reuse. Modes are session-only: new sessions/reload default to auto-app; ordinary settling, provider changes and tree navigation retain the current mode. Neither command changes macOS permissions or closes user applications. Status exposes `approvalMode`; tool details expose the mode and per-call approval diagnostics. No model tool argument can select an approval mode.

## Output and privacy

Return text and screenshots directly to pi. Read the official documentation emitted by the first call; use fresh AX indexes, favor incremental trees and batch only deterministic actions before observation. `paste` is more reliable than simulated typing for URLs in the tested Safari configuration.

Text: 2000 lines / 48 KiB, with full truncated text saved. Images: at most four / 24 MiB; unsupported encodings and external resource blocks are not fetched. Sniff PNG/JPEG/WebP bytes instead of trusting the native MIME field (the tested runtime sometimes labels JPEG as PNG). Save original screenshot files mode 0600 under private per-call directories, return matching MIME to the model. Screenshots/AX text can contain private data: only inspect user-authorized apps/tasks.

Artifact root: `getAgentDir()/artifacts/openai-codex-enhance/computer/<sessionId>/call-XXXX/` (same `{web,image,computer}` layout as the other tools). No automatic retention deletion is performed.

## Validation

`npm run check` runs mock MCP process tests for process reuse, serialization, metadata, cleanup, cancellation, crashes, malformed messages, startup/reset races, approval scoping, headless refusal, output bounds and cross-channel activation. Additional lifecycle tests cover automatic continuation vs settling, idle rechecks, model-visible recovery context, uncertain kernel state, hook failures, EOF cleanup, SIGTERM/SIGKILL escalation and workspace-disposal diagnostics. Policy tests also cover default/headless auto-app access, sensitive/unknown refusal, mode switching/revoke, and stale dialog/queued-grant cancellation. It never opens desktop apps.

Opt-in real test:

```sh
npm run smoke:computer -- --allow-calculator
```

This explicitly authorizes Calculator for this smoke session, reads its AX state, captures its window, and reads AX again. The smoke explicitly uses ask mode with a Calculator-only approval callback, rather than widening its scope to the new auto-app default. It also checks that endTurn disconnects, recreates the runtime for a new read-only run without repeating the app approval, and disconnects again. It does not click, type, or grant persistent OS/app permission. Files are saved in ignored `artifacts/computer-smoke/`.
