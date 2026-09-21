import { EMOTIONS, VOICE_MODELS, type VoiceRequest } from "./types.ts";

export function validateVoiceRequest(request: VoiceRequest): void {
  if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 10000)
    throw new Error("text must be nonempty and at most 10000 characters.");
  const allowed = new Set(["model", "text", "stream", "voice_setting", "audio_setting"]);
  for (const key of Object.keys(request))
    if (!allowed.has(key)) throw new Error(`Unsupported parameter: ${key}.`);
  if (request.model !== undefined && !VOICE_MODELS.includes(request.model))
    throw new Error("Invalid MiniMax speech model.");
  const vs = request.voice_setting;
  const allowedVs = new Set(["voice_id", "speed", "vol", "pitch", "emotion"]);
  for (const key of Object.keys(vs))
    if (!allowedVs.has(key)) throw new Error(`Unsupported voice_setting key: ${key}.`);
  if (!vs.voice_id || vs.voice_id.length > 256) throw new Error("voice_id must be 1–256 characters.");
  for (const [key, min, max] of [
    ["speed", 0.5, 2],
    ["vol", 0, 10],
    ["pitch", -12, 12],
  ] as const) {
    const value = vs[key];
    if (value !== undefined && (typeof value !== "number" || value < min || value > max))
      throw new Error(`${key} must be a number between ${min} and ${max}.`);
  }
  if (vs.emotion !== undefined && !EMOTIONS.includes(vs.emotion))
    throw new Error(`emotion must be one of: ${EMOTIONS.join(", ")}.`);
  const audio = request.audio_setting;
  if (
    audio.sample_rate !== 32000 ||
    audio.bitrate !== 128000 ||
    audio.format !== "mp3" ||
    audio.channel !== 1
  )
    throw new Error("audio_setting is fixed to 32 kHz mono MP3 at 128 kbps.");
}
