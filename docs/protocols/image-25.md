# OpenAI image channel

`gen_image` with `provider: openai` uses the existing Codex subscription HTTP channel, not the public OpenAI API. Its model choices are `gpt-image-2.5-flare` (default), `gpt-image-2.5-sunburst`, and `gpt-image-2`.

Common inputs: explicit prompt, optional image references, model, deadline. OpenAI options live under `options.openai`: size, quality and background. One PNG is requested per call; no requested partial images. Moderation is fixed internally to low, which is not a policy bypass. Original files are preserved and backend-observable discrepancies are reported. Internal backend model routing cannot be independently verified from responses lacking a model identity.

No generation/edit retry is automatic. Local and remote references are explicit; conversation images are never attached implicitly. Maximum input sizes, dimensions and counts are enforced by the module. Credentials are provided by the host resolver for `openai/codex`, validated against the fixed ChatGPT origin, and never substituted with a public API key.

Implementation and regression tests are in `packages/capabilities/gen_image/openai/` and `tests/ported/openai/image/`.
