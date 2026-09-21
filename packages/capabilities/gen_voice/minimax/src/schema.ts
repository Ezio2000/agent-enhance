import { Type, type Static } from "typebox";
import { object, text, choices } from "../../../../transports/minimax/src/schema.ts";
import { EMOTIONS, SYSTEM_VOICES, TEXT_MAX_CHARS, VOICE_MODELS, VOICE_TIMEOUT } from "./types.ts";

export const VoiceSchema = object({
  text: text(
    `Text to synthesize, at most ${TEXT_MAX_CHARS} characters. Pronunciation dictionaries and pause markers are not exposed.`,
    TEXT_MAX_CHARS,
  ),
  model: Type.Optional(choices(VOICE_MODELS, "Default speech-2.8-hd (higher fidelity); turbo is faster.")),
  voice_id: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description: `System voice (e.g. ${SYSTEM_VOICES.slice(0, 4).join(", ")}, …), a cloned voice_id, or a designed voice. Default male-qn-qingse. Full list via /v1/get_voice.`,
    }),
  ),
  emotion: Type.Optional(choices(EMOTIONS, "Optional emotional rendering; supported by speech-2.8 models.")),
  speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 2, description: "Speech speed; default 1.0." })),
  vol: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "Volume; default 1.0." })),
  pitch: Type.Optional(
    Type.Number({ minimum: -12, maximum: 12, description: "Pitch offset in semitones; default 0." }),
  ),
  timeout_seconds: Type.Optional(
    Type.Integer({
      minimum: VOICE_TIMEOUT.minSeconds,
      maximum: VOICE_TIMEOUT.maxSeconds,
      description: `Default ${VOICE_TIMEOUT.defaultSeconds}. Synthesis is never automatically retried.`,
    }),
  ),
});
export type VoiceArgs = Static<typeof VoiceSchema>;
