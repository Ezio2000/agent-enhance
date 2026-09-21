# MiniMax Token Plan protocol

Implementation: `packages/transports/minimax/src/`, capabilities `packages/capabilities/gen_image/minimax/` and `packages/capabilities/gen_voice/minimax/`.

Channel `minimax/token-plan` resolves the `sk-cp-` Token Plan key through the host (`minimax-cn` in Pi). The credential baseUrl points at the chat API; only its origin is adopted and media endpoints always live under `/v1` on `api.minimaxi.com` (CN) or `api.minimax.io` (international). Anything else is refused.

Live-probed behaviors that differ from or are missing in public docs:

- **Business codes on HTTP 200.** `base_resp.status_code` must be checked everywhere: `0` success, `2013` invalid params (an unknown task_id yields 200 + 2013), `2067` plan tier/quota limit. Errors carry actionable Chinese messages; they are surfaced verbatim with an English hint appended.
- **Image response shape.** `POST /v1/image_generation` returns `data.image_base64[]` for `response_format:"base64"` and `data.image_urls[]` for `"url"` — not the documented `data[].b64_json`. Output observed as JPEG 1024×1024 on an OSS signed URL; the saved extension follows the actual magic bytes. `n` is fixed to 1; the module is generation-only (no edit references).
- **Speech audio is hex.** `POST /v1/t2a_v2` (non-streaming) returns `data.audio` hex-encoded MP3 — not base64. Audio is fixed internally to 32 kHz mono MP3 at 128 kbps; only verified parameters are exposed.
- **Media quotas are invisible to the quota API.** Images/day and TTS chars/day are enforced server-side with their own allowances. `GET /v1/token_plan/remains` returns only `general` and `video` rows: its `remains_time` was measured to decrement 1:1 with wall clock even when idle (it is a window countdown, not a balance), its count fields stayed `0/0` after real image/TTS consumption, and its percent fields were inconsistent (50% fresh, 99% after use). Cards therefore never render a quota line; the voice card reports the real per-call `extra_info.usage_characters`, and hitting a media allowance surfaces `2067`.
- **Video is gated.** `POST /v2/video_generation` rejects Token Plan keys for the whole MiniMax-H3 family; `POST /v1/video_generation` accepts the request shape but returns `2067` on tiers without a video allowance. No video capability is registered for this provider.

No generation or synthesis request is retried automatically. Credentials are only sent to the two pinned MiniMax origins and are redacted from every error path (`sk-cp-…` included).
