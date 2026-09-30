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

On 2026-09-30, the user authorized system permissions for Agent Enhance Computer. Stale macOS signature records initially left enabled Settings switches with denied native permissions. Resetting only this app's Accessibility/ScreenCapture records and re-adding the current materialized app resolved the mismatch; native checks confirm all three grants. The opt-in `NATIVE_COMPUTER_LIVE=1` test subsequently passed three consecutive isolated runs: background AXPress and Unicode setValue preserve the front fixture's focus; foreground click, Command-A and Unicode typing produce the exact expected text; window capture returns a real PNG; Shift-drag updates the fixture; obsolete element IDs are rejected. Fixture setup explicitly selects the front window and provides the standard Edit/Select All menu.

The final automated suite passes 155 tests with the opt-in UI test skipped in ordinary runs. Four Swift tests pass. Linux/macOS CI passes with both Pi 0.86.1 and latest. Public HTTPS distribution verification passes, and committed builds reproduce without Swift on Linux.

Claude Code 2.1.285 was updated through the Git marketplace/plugin workflow, followed by an explicit native module update. Fresh model sessions loaded the installed `cc-enhance@agent-enhance` Git cache, using the user's configured MiniMax-M3.1-Flash-Preview model. No local plugin override was used. The tested native module is pinned to source commit `c160f6037ac4f39ea35e2616b9efec8cce0c5712`, SHA-256 `7712c3ffccc574f22d355adc39a230ba658cf88e5dc02dba121878a9c8542756`.

All 35 actual tool results across four Claude Code sessions were inspected: 26 succeeded, five were explicit negative cases, and four were model API mistakes. The mistakes were a wrong permissions field path, two misplaced click mode arguments, and a missing await on getApp. Each was corrected before continuing; the final UI session passed every behavior after its read-only await correction. Tool/schema descriptions now expose the permissions shape and separate options argument before first execution. Misplaced mode is rejected before native dispatch. These errors are not counted as successful calls, even though Claude Code's final session results reported success.

The negative cases cover a thrown JS error, stale IDs in both UI runs, an exception after actual Shift/mouse-down, and a timeout after actual Shift-down. The exception recovery drag reports `drag: true shift: false` without manually releasing input. Timeout status reports one released key, native/worker stopped and workspace removed; the next call has a fresh generation, no previous JS bindings, and another successful unmodified drag. The failure-cleanup session has eight successful results, two expected failures and zero unexpected failures. No failed operation was automatically replayed.

Real Claude Code captures were visually checked: the 1000×764 PNG shows the fixture's exact Chinese/emoji text and count of one, matching 500×382 logical bounds at 2× scale. Stop hooks exited successfully, and every recorded native/worker PID was independently confirmed stopped. Disposable fixture apps and temporary validation files were removed; no desktop observations or screenshots are committed. Modifier-scope failures also retain both the original action error and any release error, with host cleanup still releasing held input.
