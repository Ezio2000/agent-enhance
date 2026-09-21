import { Value } from "typebox/value";
import { annotateError } from "../../../../core/src/errors.ts";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { VoiceArtifactStore } from "./artifacts.ts";
import { VoiceClient } from "./client.ts";
import { VoiceSchema, type VoiceArgs } from "./schema.ts";
import { VOICE_DEFAULTS, VOICE_TIMEOUT, type VoiceRequest } from "./types.ts";
import { validateVoiceRequest } from "./validation.ts";

type Details = Record<string, unknown>;
const SNIPPET_LENGTH = 60;

export function snippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat;
}
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export interface VoiceDependencies {
  client(ctx: ExecutionContext): VoiceClient;
  artifacts: VoiceArtifactStore;
}

export function voiceWireOptions(args: VoiceArgs): VoiceRequest {
  return {
    model: args.model ?? VOICE_DEFAULTS.model,
    text: args.text,
    stream: false,
    voice_setting: {
      voice_id: args.voice_id ?? VOICE_DEFAULTS.voice_id,
      speed: args.speed ?? VOICE_DEFAULTS.speed,
      vol: args.vol ?? VOICE_DEFAULTS.vol,
      pitch: args.pitch ?? VOICE_DEFAULTS.pitch,
      ...(args.emotion === undefined ? {} : { emotion: args.emotion }),
    },
    audio_setting: {
      sample_rate: VOICE_DEFAULTS.sample_rate,
      bitrate: VOICE_DEFAULTS.bitrate,
      format: VOICE_DEFAULTS.format,
      channel: VOICE_DEFAULTS.channel,
    },
  };
}

export function voiceTool(deps: VoiceDependencies): ToolDefinition<typeof VoiceSchema, Details> {
  return {
    name: "gen_voice",
    label: "MiniMax Voice",
    description: `Synthesize speech from text with MiniMax speech-2.8 (hd or turbo) over the Token Plan channel. Verified voices include system IDs such as male-qn-qingse, female-shaonv or presenter_female; cloned or designed voice IDs work as well. Optional emotion rendering (happy, sad, calm, whisper, …) and speed/vol/pitch controls. Output is fixed internally to 32 kHz mono MP3 at 128 kbps and saved as a local original. The TTS character allowance is a separate daily quota enforced server-side and not exposed by any quota API; the per-call billed characters are reported from extra_info.usage_characters, and hitting the limit surfaces error 2067. Synthesis is never automatically retried.`,
    promptSnippet: "Synthesize speech with MiniMax speech-2.8 via the Token Plan",
    promptGuidelines: [
      "Use gen_voice when the user requests text-to-speech or a voiceover. Refer to the saved mp3 path; do not claim audio was produced if the tool failed.",
    ],
    parameters: VoiceSchema,
    async execute(callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(VoiceSchema, args))
        throw new Error("Invalid gen_voice arguments; use the current tool schema.");
      const request = voiceWireOptions(args);
      validateVoiceRequest(request);
      const startedAt = Date.now();
      const elapsedSeconds = () => (Date.now() - startedAt) / 1000;
      onUpdate?.({
        content: [{ type: "text", text: `Synthesizing speech with ${request.model}…` }],
        details: { status: "in_progress", elapsedSeconds: elapsedSeconds() },
      });
      let result: Awaited<ReturnType<VoiceClient["speak"]>>;
      try {
        result = await deps.client(ctx).speak(request, {
          signal,
          timeoutMs: (args.timeout_seconds ?? VOICE_TIMEOUT.defaultSeconds) * 1000,
        });
      } catch (error) {
        throw annotateError(
          error,
          `\nText: "${snippet(request.text)}" · elapsed ${formatElapsed(elapsedSeconds())}`,
        );
      }
      signal?.throwIfAborted();
      const voice = await deps.artifacts.saveVoice(ctx.sessionId, result.data.audio, signal);
      const usage = result.data.extraInfo?.usageCharacters;
      const summary = [
        `"${snippet(request.text)}"`,
        request.model,
        request.voice_setting.voice_id,
        `elapsed ${elapsedSeconds().toFixed(1)}s`,
        ...(usage !== undefined ? [`${usage} chars used`] : []),
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        content: [
          {
            type: "text",
            text: `Voice: ${voice.path} (${voice.bytes} bytes)\n${summary}\nOriginal file is saved. Do not re-encode; reuse the path.`,
          },
        ],
        details: {
          version: 1,
          status: "completed",
          operation: "synthesize",
          model: request.model,
          voiceId: request.voice_setting.voice_id,
          emotion: request.voice_setting.emotion,
          voice,
          extraInfo: result.data.extraInfo,
          elapsedSeconds: elapsedSeconds(),
          traceId: result.data.traceId,
          requestId: result.requestId,
        },
      };
    },
  };
}
