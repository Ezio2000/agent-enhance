# Independent native Computer Use protocol

Implementation: `packages/capabilities/use_computer/native/`. No official runtime, plugin manifest, login, Sky service, or OpenAI policy code is used.

## Execution

`use_computer({code,title?,timeout_seconds?})` executes plain JavaScript in a persistent Node REPL child. The whole-call deadline defaults to 60 seconds (1–120). `computer` supplies app/window operations; `print` and the final expression supply output. Initial execution emits the local API documentation; `computer.help()` returns it on demand. Top-level await and bindings survive automatic continuation until task settlement. Both REPL error channels terminate the call.

A host session owns one JS worker and one native app instance. Worker RPCs execute serially over a private Unix socket. Calls carry an owning call ID; queued or detached requests cannot execute after it expires. The internal newline-delimited protocol uses `{id,method,params}` and `{id,result}` / `{id,error:{code,message,indeterminate,details}}`. `hello` reports protocol 1, native PID, generation, OS permissions, isolation policy and directed-pointer availability. `beginCall`, `endCall` and `shutdown` manage lifetime. An independent socket reader accepts control requests during awaiting native actions: teardown cancels the active task, discards queued requests and awaits original-route input release before replying.

## Targets and delivery

Use exact bundle IDs and opaque window IDs returned by state/window lists. Closed windows and old process generations are rejected. Each observation replaces that window's element IDs and exposes AX roles, labels, values, geometry, actions, value mutability and selected text ranges. Element operations revalidate ownership. Coordinate input requires matching observed geometry; window IDs are matched to the actual CGWindow owner PID.

The host captures `AGENT_ENHANCE_COMPUTER_ISOLATION` at session creation: `isolated-only` by default, or explicit `shared`. Worker, host RPC and native gates refuse foreground mode, activation and foreground launch under isolated-only. Tool code cannot relax the policy. Directed raw input to the user's active application is refused because PID keyboard delivery shares that app's key window. Semantic AX edits can address an inactive sibling, but writes to the active user window are refused. Background AX focus selection is confined to inactive applications; post-action checks detect unexpected foreground/key-window changes. This is conditional host-window isolation, not a separate OS input seat.

Background is the default. AX actions, menus and plain single-element clicks prefer app semantics. `setValue` and `replaceText` read the actual value after writing. `selectAll` and `selectText` use writable AX selected ranges; UTF-16 ranges cannot split surrogate pairs. An inactive app's window/element is selected where text controls require it. No unverified Command-A fallback is used.

Background keyboard needs an observed element and confirmed app key window. Raw holds, scoped modifiers, pointer moves, coordinate/right/double clicks, drag and scroll also support background. Pointer events carry explicit window identity, a window-local position and only the context's held modifiers. The window coordinate route depends on private `CGEventSetWindowLocation`; missing symbols fail explicitly. Some inactive controls ignore unmodified mouse input. Command is never silently added to make them respond. The logical cursor does not move, hide or restore the user's real pointer.

`expect:{element,value?,selectedRange?,timeout_ms?}` observes effects, with a 0–2000 ms deadline. Mismatch throws `EFFECT_MISMATCH`, retaining expected/observed values and target/route; subsequent awaited actions do not execute. Without an expectation, raw input remains `dispatched` with `effectConfirmed:false`. Arbitrary app shortcuts, hover behavior and sibling keyboard routing cannot be inferred from successful event posting. Unsupported routes never become foreground retries.

Each input context owns its source state, logical cursor, keys/buttons and immutable PID/window/channel. `withKeys` inherits target/mode and releases acquired keys in finally; held scopes cannot switch route or geometry. Explicit key/button release resumes the original owned route, including after a focus/geometry change. Cross-process PID leases exclude other CU sessions from the same app for the call; shared foreground input also has a global lease. Release sends mouse-up before modifier-up, reports failures and retains failed ownership for retry. Holds never span calls. Error/reset/signal/disconnect cleanup releases only owned synthetic state. Completed effects are not undone and no operation is replayed.

## Output and diagnostics

Window screenshots use ScreenCaptureKit and PNG. Coordinates are window-relative logical points; metadata supplies global bounds and pixel scale. Minimized/unavailable targets fail explicitly. Output is limited to 2000 lines / 48 KiB and four PNG images / 24 MiB per call. Truncated text is saved completely.

Every script/native failure starts with a concise summary before API docs or user output. Complete JSON diagnostics retain generation, captured output, all operations, native error details, target/delivery, cleanup and saved screenshot paths. Caught native errors remain visible as `completed_with_operation_errors`; they are not counted as confirmed success. MCP failure responses retain the original image blocks and diagnostics in metadata. Claude Code 2.1.285 folds images into text on `isError`; `computer.showImage(savedPngPath)` displays an existing PNG in a subsequent successful call without replaying UI input or recapturing the screen. Diagnostic metadata does not replace the actual text/docs/images with `structuredContent`.

## Distribution and lifecycle

`npm run build:computer-native` builds macOS 14+ arm64/x86_64, creates a universal ad-hoc signed app and packs it with a source fingerprint. Normal builds verify and embed the committed payload; users need no compiler or additional runtime download.

`ModuleServices.runtimeRoot` selects the content-addressed cache, normally `<home>/runtimes`. Instances launch through LaunchServices without activation or daemon registration. Cleanup stops only the owned native PID/JS worker and removes the socket workspace; cache and user artifacts remain. `task_settled` disposes resources when idle; session shutdown, branch/provider changes, reset and unload also clear bindings.

Status does not launch a service and reports uninspected permissions as `not_checked`. Management supports status/reset; macOS owns Accessibility, Screen Recording and Event Synthesizing permissions. Ad-hoc signed updates may require renewed OS grants. Notarized Developer ID distribution and a guest desktop/VM are outside this module.
