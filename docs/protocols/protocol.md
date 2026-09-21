# Provider protocols

## OpenAI / Codex

`search_web` uses the Codex search endpoint, retaining backend reference IDs for follow-up open/click/find requests. Cite original source URLs. Search can include only the recent host-provided user/assistant text window; system prompts, thinking, tool results and file contents are excluded. Text output is bounded and oversized results are saved privately.

`gen_image` uses the Codex image generation/edit endpoints. OAuth account claims and fixed target-origin checks are preserved. Transport errors redact credentials and do not automatically retry generation.

## xAI / Imagine

`gen_image` and `gen_video` use the existing xAI Imagine HTTP routes with host-resolved OAuth. Video generation submits once, polls a returned request ID, and downloads the completed artifact without sending provider authentication to the output URL. A timeout may leave remote computation running; it does not authorize resubmission.

## OpenCode / Go

`view_pdf` and `view_video` call Responses with model `muse-spark-1.3-contributor`, explicit `input_file`, `store:false`, and a generated `x-opencode-session` header. Authentication is an API key resolved by the host. Audio input is rejected because the currently verified channel does not understand it. Contributor-tier data-use policies apply; do not upload secrets.

## Contract

Supplier-specific clients live under function/provider directories; shared transport helpers live under `packages/transports/<provider>`. Host login discovery and UI belong exclusively to `packages/hosts/<agent>`. No client falls back to another provider, API route or credential source after a failure.
