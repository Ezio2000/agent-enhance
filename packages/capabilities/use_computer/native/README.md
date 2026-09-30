# use_computer / native

Independent macOS 14+ automation using a bundled universal Swift runtime and a persistent Node JavaScript REPL. No ChatGPT app, Codex login, external CLI or user-installed Swift is required.

Enable with `/pi-enhance native use_computer enable` or `/cc-enhance native use_computer enable`. Management supports `status` and `reset`. macOS Accessibility, Screen Recording and Event Synthesizing permissions are requested only when needed.

Start with `await computer.getState()`. Full local API documentation is emitted on first use and available through `computer.help()`. Background AX actions are the default; shared keyboard/mouse input requires explicit foreground mode. See the root Computer Use section and `docs/protocols/computer-use.md`.
