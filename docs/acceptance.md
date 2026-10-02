# Acceptance — 0.3.0

Verified locally on macOS with Pi 0.86.1 on 2026-10-02. The full check passed 171 tests, the offline packed-release probe, strict types, formatting and dependency boundaries. Claude Code plugin validation passed (the manifest intentionally has no fixed plugin version).

The automated acceptance target is `npm run check`. It exercises the service-discovery architecture with isolated stores and synthetic credentials; no real model or desktop calls are required.

| Area         | Required behavior                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boundaries   | Core has no configuration/discovery readers; discovery has no host SDK dependency; Claude Code has no Pi SDK dependency                                                 |
| Discovery    | Original sources, domestic/global connections, expired-but-refreshable OAuth and environment values are recognized without network, Key commands or copied credentials  |
| Refresh      | Rotating OAuth refresh serializes and writes only to the original source, preserving unrelated entries                                                                  |
| Routing      | Multiple services share one tool; exact connection selection binds the matching resolver; ambiguity, unavailable preferences and cross-provider options fail explicitly |
| Lifecycle    | Busy exclusions reject new calls; completion permits disposal; stale handles cannot execute during unload                                                               |
| Pi           | Real SDK registration, dynamic schemas, native tool exclusions, model-derived vision availability, request settings and subagent controls remain functional             |
| Claude Code  | Existing credentials produce tools automatically; login/logout and preferences update MCP tools live; hooks retain session state; descriptions fit the host limit       |
| SDK          | Standalone Core and provider bundles execute without Pi, discovery or node_modules                                                                                      |
| Distribution | Unpacked release includes all modules and discovers synthetic credentials without downloading code or invoking models                                                   |

Live protocol/media trials from earlier releases do not establish acceptance of the discovery refactor. A new live trial must be explicitly requested and reported separately from these offline checks. Local verification does not imply the remote CI or installed release has been updated.
