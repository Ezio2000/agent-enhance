# use_computer / native

Independent macOS 14+ automation using a bundled universal Swift runtime and a persistent Node JavaScript REPL. No ChatGPT app, Codex login, external CLI or user-installed Swift is required.

Enable with `/pi-enhance native use_computer enable` or `/cc-enhance native use_computer enable`. Management supports `status` and `reset`. macOS Accessibility, Screen Recording and Event Synthesizing permissions are requested only when needed.

Start with `await computer.getState()`. Full local API documentation is emitted on first use and available through `computer.help()`. Background AX actions are the default; shared keyboard/mouse input requires explicit foreground mode. See the root Computer Use section and `docs/protocols/computer-use.md`.

The app is materialized at `<Agent Enhance home>/runtimes/native-computer/<payload hash>/Agent Enhance Computer.app`. Since 0.4.1 native builds reuse a fixed self-signed certificate and a certificate-bound designated requirement. Migration from the old ad-hoc signature needs one renewed grant; subsequent upgrades using the same identity can retain grants. Each new Mac still requires its own initial grants; this is not Apple Developer ID or notarization. If System Settings shows an enabled switch while `computer.getState()` reports denied permissions, remove and re-add the current app in Accessibility (Device Control and Data Access on newer macOS) and Screen Recording. Reopen the computer runtime after granting access; do not treat the switch alone as proof of authorization.
