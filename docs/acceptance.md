# Acceptance — 0.2.0

Verified locally on macOS with Pi 0.86.1 on 2026-09-21.

## Automated

- 101 tests pass, including 84 migrated protocol/runtime regressions.
- Strict TypeScript, uniform Prettier formatting and host dependency boundaries pass.
- A clean-directory Node process imports the standalone base and both image bundles without Pi/node_modules; exactly one merged `gen_image` is exposed.
- Real Pi SDK tests execute install/load/unload commands and dynamic schema refresh, preserve excluded tools, and do not call a model.
- Production dependency audit reports no known vulnerabilities at acceptance time.

## Installed extension trial

The three previous Pi package entries were replaced by the new local Agent Enhance package. Prior settings were backed up, old source directories and artifacts retained, and all 10 previous capabilities were installed/loaded with saved Pi preferences. Image generation defaults to OpenAI; explicit xAI remains available through the same tool.

Real tool calls through the installed Pi extension passed:

| Operation               | Result                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `search_web` / OpenAI   | Search returned source-bearing text                                                   |
| `view_pdf` / OpenCode   | Synthetic PDF verification code returned correctly                                    |
| `view_video` / OpenCode | Synthetic video returned a nonempty color answer                                      |
| `gen_image` / OpenAI    | One original PNG saved                                                                |
| `gen_image` / xAI       | One original JPEG saved                                                               |
| `gen_video` / xAI       | One six-second-request MP4 saved                                                      |
| `use_computer` / OpenAI | Historical read-only `cua.getState()` trial; superseded by native implementation      |
| Desktop cleanup         | Hook OK; process group stopped; workspace removed; disconnected; no cached app grants |

A further actual Pi CLI model run (OpenAI main model, only `view_pdf` enabled, OpenCode tool backend) returned `BLUE-42` from the fixture. This validates the model-to-registered-tool path in addition to direct SDK execution. No clicks, sends, deletions, payments or permission changes were performed in the desktop trial.

Detailed reports and generated media remain under ignored local `artifacts/smoke/` and the user's Agent Enhance artifact directory. No account information or desktop observations are committed.

## Distribution

The Pi package includes only the host bundle, module catalog and documentation; optional capability bundles are excluded from its tarball. Source/Git installation necessarily clones the full repository. The release catalog is pinned to an immutable commit with SHA-256/length checks for each independently downloadable module. Actual HTTPS downloads of both image modules, their merged registration, and fresh-process Pi install/load from the roughly 24 KB minimal tarball all passed. Linux and macOS GitHub Actions also passed.

Existing running Pi sessions retain their old extension runtime until the native `/reload` command or a restart. Fresh sessions load the replacement immediately.

## Native Computer Use acceptance

The previous official-runtime desktop trial is superseded by `use_computer/native`. On 2026-09-30, the embedded universal app started, completed its socket handshake and app-state query, and exited with its JS worker and socket workspace removed. The test sets the old ChatGPT app path to a nonexistent location. A clean-directory test imports only the native module bundle and needs neither the checkout, node_modules nor Swift.

Real JS worker tests cover persistent top-level await, task settlement/continuation, background defaults, modifier cleanup, ordered side effects, partial-operation diagnostics, cancellation, deadlines and rejection of late callbacks. Node 22 also passes these worker tests. Swift unit tests cover coordinates, key validation, foreground lease exclusion/release and focus changes.

On 2026-09-30, the user authorized system permissions for Agent Enhance Computer. Stale macOS signature records initially left enabled Settings switches with denied native permissions. Resetting only this app's Accessibility/ScreenCapture records and re-adding the current materialized app resolved the mismatch; native checks confirm all three grants. The opt-in `NATIVE_COMPUTER_LIVE=1` test subsequently passed three consecutive isolated runs: background AXPress and Unicode setValue preserve the front fixture's focus; foreground click, Command-A and Unicode typing produce the exact expected text; window capture returns a real PNG; Shift-drag updates the fixture; obsolete element IDs are rejected. Fixture setup explicitly selects the front window and provides a Select All key equivalent.

The final automated suite passes 155 tests with the opt-in UI test skipped in ordinary runs. Four Swift tests pass. Linux/macOS CI passes with both Pi 0.86.1 and latest. Public HTTPS distribution verification passes, and committed builds reproduce without Swift on Linux.

Claude Code 2.1.285 was updated through the Git marketplace/plugin workflow, followed by an explicit native module update. Fresh model sessions loaded the installed `cc-enhance@agent-enhance` Git cache, using the user's configured MiniMax-M3.1-Flash-Preview model. No local plugin override was used. The tested native module is pinned to source commit `c160f6037ac4f39ea35e2616b9efec8cce0c5712`, SHA-256 `7712c3ffccc574f22d355adc39a230ba658cf88e5dc02dba121878a9c8542756`.

All 35 actual tool results across four Claude Code sessions were inspected: 26 succeeded, five were explicit negative cases, and four were model API mistakes. The mistakes were a wrong permissions field path, two misplaced click mode arguments, and a missing await on getApp. Each was corrected before continuing; the final UI session passed every behavior after its read-only await correction. Tool/schema descriptions now expose the permissions shape and separate options argument before first execution. Misplaced mode is rejected before native dispatch. These errors are not counted as successful calls, even though Claude Code's final session results reported success.

The negative cases cover a thrown JS error, stale IDs in both UI runs, an exception after actual Shift/mouse-down, and a timeout after actual Shift-down. The exception recovery drag reports `drag: true shift: false` without manually releasing input. Timeout status reports one released key, native/worker stopped and workspace removed; the next call has a fresh generation, no previous JS bindings, and another successful unmodified drag. The failure-cleanup session has eight successful results, two expected failures and zero unexpected failures. No failed operation was automatically replayed.

Real Claude Code captures were visually checked: the 1000×764 PNG shows the fixture's exact Chinese/emoji text and count of one, matching 500×382 logical bounds at 2× scale. Stop hooks exited successfully, and every recorded native/worker PID was independently confirmed stopped. Disposable fixture apps and temporary validation files were removed; no desktop observations or screenshots are committed. Modifier-scope failures also retain both the original action error and any release error, with host cleanup still releasing held input.

## Extended Claude Code end-to-end acceptance

On 2026-09-30, the official Claude Agent SDK drove 16 actual Claude Code 2.1.285 processes through the installed Git plugin and the user's configured MiniMax model. Streaming user turns exercised the same Claude process across Stop, reset and interruption. There were 70 tool uses and 69 returned results; one tool was deliberately interrupted by killing its owning Claude process before a result could return. Of the returned results, 56 did not set `is_error`, nine were intentional negative cases, and four were test-code or fixture-setup errors corrected before the corresponding behavior passed. Fifteen additional native negative checks were caught by JS and verified in the returned operation diagnostics; they were not treated as successful native actions.

The four setup errors were an unescaped newline in a generated JS string, an assumed `Edit` menu title (macOS displays the fixture's first menu as its application name), a missing variable when continuing only the remaining test blocks, and a launch fixture that LaunchServices could not select. The launch fixture was rebuilt for macOS 14 and temporarily registered under the user's Applications directory: LaunchServices marks apps in temporary directories as launch-disabled. Accepted effects were observed before starting new test cases; failed actions were not automatically replayed.

| Scenario                              | Verified behavior                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two apps with identical window titles | Exact window ownership and cross-window element rejection; independent observations; background AXPress and ordered `Promise.all` value writes preserve foreground focus                                                                                               |
| Geometry and capture                  | Move/resize invalidates coordinate observations; fresh observations restore physical clicks; minimized capture fails explicitly; restored background capture preserves focus and reports 2× scaling                                                                    |
| Menus, text and input scopes          | Select All plus Chinese/emoji typing produces the exact value; background keyboard delivery changes the observed value without activation; nested Shift/Option drag works; changing a scope's window or mode is rejected; subsequent drag has no held Shift            |
| Partial and detached work             | One accepted click followed by a stale-element failure increments only once; an old timer cannot mutate the UI after its call ends                                                                                                                                     |
| Same-process lifecycle                | Stop clears JS bindings and changes generation while retaining fixture UI; explicit reset clears bindings again; actual SDK interrupt releases an accepted Shift and mouse hold                                                                                        |
| Concurrent Claude processes           | Background AX operations work while the other process holds foreground input; foreground input returns `INPUT_BUSY` before activation or mutation; JS state and generations are independent; cancelling the owner restores foreground operations                       |
| Active native reset                   | Host control API reset interrupts a five-second native drag, clears queued `setValue`, stops native/worker and permits fresh unmodified input                                                                                                                          |
| Target and host exit                  | Relaunch changes PID and window IDs; old handles return `STALE_TARGET`; missing apps return `APP_TARGET`; killing Claude with accepted input stops its MCP server, native process and worker; a new session observes no late mutation and completes an unmodified drag |
| Output bounds                         | Five captures return five metadata records and four PNG blocks with an omission notice; 3000 log rows have a 49,337-byte visible result and a 174,021-byte full output retaining the tail marker                                                                       |

Active reset exposed a diagnostic defect: teardown cleared the generation before returning the interrupted call, so a successfully started runtime was labelled `startup failed`, misleading the model. The call now retains its started generation for diagnostics while live session state is cleared. A regression checks accepted input, cancellation, the formatted error and fresh-state recovery. Source commit `2b2c3b390357e6ec0ce6fe05a1a83bd01213c224` was published through the immutable catalog workflow, and plugin `e04203780950` was installed from Git followed by an explicit module update. The tested module SHA-256 is `f497be392a0128dfb7db67d298ea24f82148a9268f8da94d67fec022fd107e4a` (804,019 bytes). Installed-plugin retests of active reset and a first-call three-second timeout retain the correct generation, reject late work and recover successfully.

During an active native drag, serial native processing can block the graceful shutdown reply beyond its 1.5-second deadline. Status retains `Native shutdown timed out`; the existing SIGTERM fallback stops the native process, releases the input lease and removes its workspace. Release counts are unavailable on that fallback, so actual subsequent unmodified dragging was checked. During JS waits, ordinary cancellation/timeout cleanup explicitly reports one released key and one released mouse button. Claude's own interrupt result uses generic rejection wording even after input was accepted; independent status and UI checks establish the actual effects and cleanup.

`npm run check` passes with 156 tests and one opt-in UI test skipped. All four Linux/macOS and pinned/latest Pi CI jobs pass for the published fix, including native Swift tests on macOS. Public HTTPS distribution verification and minimal package validation pass. All 62 recorded Claude/native/worker PIDs were independently confirmed stopped, all owned control sockets disappeared, and the foreground lease was free. Three disposable fixture processes, their registrations, screenshots, full-output files and temporary SDK/harness files were removed. No desktop observations or screenshots are committed.
