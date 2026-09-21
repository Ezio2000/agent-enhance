import {
  HTTPTransport,
  ProtocolError,
  businessError,
  isRecord,
} from "../../../../transports/minimax/src/http.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/minimax/src/types.ts";
import { VOICE_TIMEOUT, type VoiceExtraInfo, type VoiceRequest, type VoiceResponse } from "./types.ts";
import { validateVoiceRequest } from "./validation.ts";

const numberField = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class VoiceClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  /** Non-streaming t2a_v2. data.audio is hex-encoded MP3 — verified live, not base64. */
  async speak(
    request: VoiceRequest,
    options: RequestOptions = {},
  ): Promise<{ data: VoiceResponse; requestId?: string }> {
    validateVoiceRequest(request);
    return this.http.post<VoiceResponse>("t2a_v2", request, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? VOICE_TIMEOUT.defaultSeconds * 1000,
      consume: async (response, signal, requestId, secrets) => {
        const payload: unknown = await response.json();
        signal.throwIfAborted();
        const failure = businessError(payload, requestId, secrets);
        if (failure) throw failure;
        const root = isRecord(payload) ? payload : {};
        const data = isRecord(root.data) ? root.data : undefined;
        const hex = typeof data?.audio === "string" ? data.audio : "";
        if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex))
          throw new ProtocolError("MiniMax speech response is missing hex audio; nothing was synthesized.");
        const audio = Buffer.from(hex, "hex");
        if (!audio.length) throw new ProtocolError("MiniMax returned empty audio; nothing was synthesized.");
        const extra = isRecord(root.extra_info) ? root.extra_info : undefined;
        const extraInfo: VoiceExtraInfo = {
          ...(numberField(extra?.audio_length) !== undefined
            ? { audioLength: numberField(extra?.audio_length) }
            : {}),
          ...(numberField(extra?.audio_sample_rate) !== undefined
            ? { audioSampleRate: numberField(extra?.audio_sample_rate) }
            : {}),
          ...(numberField(extra?.audio_size) !== undefined
            ? { audioSize: numberField(extra?.audio_size) }
            : {}),
          ...(numberField(extra?.bitrate) !== undefined ? { bitrate: numberField(extra?.bitrate) } : {}),
          ...(numberField(extra?.word_count) !== undefined
            ? { wordCount: numberField(extra?.word_count) }
            : {}),
          ...(numberField(extra?.usage_characters) !== undefined
            ? { usageCharacters: numberField(extra?.usage_characters) }
            : {}),
          ...(typeof extra?.audio_format === "string" ? { audioFormat: extra.audio_format } : {}),
          ...(numberField(extra?.audio_channel) !== undefined
            ? { audioChannel: numberField(extra?.audio_channel) }
            : {}),
        };
        return {
          audio,
          extraInfo,
          ...(typeof root.trace_id === "string" ? { traceId: root.trace_id } : {}),
        };
      },
    });
  }
}
