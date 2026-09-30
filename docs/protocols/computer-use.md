# Independent native Computer Use protocol

Implementation: `packages/capabilities/use_computer/native/`. No official runtime, plugin manifest, login, Sky service, or OpenAI policy code is used.

## Execution

`use_computer({code,title?,timeout_seconds?})` executes plain JavaScript in a persistent Node REPL child. The whole-call deadline defaults to 60 seconds (1–120). `computer` supplies app/window operations; `print` and the final expression supply output. Initial execution emits the local API documentation; `computer.help()` returns it on demand. Top-level await and bindings survive automatic continuation until task settlement. The default REPL error channel and ordinary eval callback both terminate the call.

A host session owns one JS worker and one native app instance. The host dispatches worker RPCs serially over a private Unix socket to its Swift service. Calls carry an owning call ID; queued or detached requests cannot execute after it expires. The native protocol is newline-delimited JSON with `{id,method,params}` requests and `{id,result}` / `{id,error:{code,message,indeterminate}}` replies; `hello` reports protocol 1, native PID, generation and OS permissions. `beginCall`, `endCall` and `shutdown` manage call/input lifetime. This protocol is internal, not a second model-facing action interface.

## Targets and delivery

Use bundle IDs from `computer.getState()` and opaque window IDs from `app.listWindows()`. Closed windows and old process generations are rejected. Each observation replaces that window's element IDs and returns AX roles, labels, values, geometry, supported actions and value mutability. Element actions revalidate the owning window. Coordinate actions require a matching observed window geometry.

Background is the default. `performAction`, `setValue`, `menu`, and a single element `click` use AX. Background keyboard requires an observed, focusable element and confirmed owning window, then posts events to the PID. Returned `dispatched` does not prove an app accepted its effect. Observe to verify; unsupported delivery never becomes a foreground retry.

Raw key/button holds, coordinate input, dragging, scrolling and modifier-mouse combinations require explicit foreground. A cross-process foreground lease lasts through the current JS call, including waits. `withKeys` inherits its window/mode inside the callback and releases acquired keys in finally. Window/mode switching during a scope is refused. All held synthetic input is released by endCall, signal cleanup and disconnect; holds never span calls. No action is replayed after errors or cancellation.

Window screenshots use ScreenCaptureKit and PNG. Coordinates are window-relative logical points; image metadata supplies global window bounds and pixel scale. Minimized/unavailable capture targets fail explicitly; restoration is a separate operation. Outputs are limited to 2000 lines / 48 KiB, with full text saved when truncated, and four PNG images / 24 MiB per call.

## Distribution and lifecycle

`npm run build:computer-native` builds macOS 14+ arm64/x86_64, creates a universal ad-hoc signed app and compresses its files with a source fingerprint into the committed native payload. Normal builds verify the fingerprint and embed the payload into the standalone ESM module. There is no user-side compiler or extra runtime download.

`ModuleServices.runtimeRoot` selects the native cache; hosts supply `<home>/runtimes`, standalone callers default to Agent Enhance's runtime directory. Native versions materialize into content-addressed app directories and share a foreground lock. Native instances launch through LaunchServices with no foreground activation; no daemon is registered. Connection loss releases input and exits the owned app. Cleanup stops only the owned native PID and JS worker and removes the socket workspace; cache and user artifacts remain.

`task_settled` disposes JS/native resources only when the host is idle. Session shutdown, branch/provider changes, reset and unload also clear bindings. Status does not launch a service and reports uninspected permissions as `not_checked`. Management supports status/reset only; macOS owns Accessibility, Screen Recording and Event Synthesizing permissions. No per-app grant broker remains. Ad-hoc signed updates may require renewed OS grants; notarized Developer ID distribution is outside this release.
