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

Real UI delivery remains unverified on this machine: the new app lacks Accessibility, Screen Recording and Event Synthesizing grants. The opt-in `NATIVE_COMPUTER_LIVE=1` fixture integration test explicitly fails when those grants are missing; it exercises background AX without stealing focus, Unicode text, screenshots, modifier-drag and stale element rejection when authorized. No successful click, keyboard, capture or drag acceptance is claimed here.
