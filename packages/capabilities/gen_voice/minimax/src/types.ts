export const VOICE_MODELS = ["speech-2.8-hd", "speech-2.8-turbo"] as const;
export type VoiceModel = (typeof VOICE_MODELS)[number];
// Verified live via /v1/get_voice and one emotion/turbo probe.
export const EMOTIONS = [
  "happy",
  "sad",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
  "whisper",
] as const;
export type Emotion = (typeof EMOTIONS)[number];
export const SYSTEM_VOICES = [
  "male-qn-qingse",
  "male-qn-jingying",
  "male-qn-badao",
  "male-qn-daxuesheng",
  "female-shaonv",
  "female-yujie",
  "female-chengshu",
  "female-tianmei",
  "presenter_male",
  "presenter_female",
  "audiobook_male_1",
  "audiobook_male_2",
  "audiobook_female_1",
  "audiobook_female_2",
] as const;
export const VOICE_DEFAULTS = Object.freeze({
  model: "speech-2.8-hd",
  voice_id: "male-qn-qingse",
  speed: 1.0,
  vol: 1.0,
  pitch: 0,
  // audio_setting fixed and verified: 32 kHz mono MP3 at 128 kbps.
  sample_rate: 32000,
  bitrate: 128000,
  format: "mp3",
  channel: 1,
} as const);
export const TEXT_MAX_CHARS = 10000;
export const VOICE_TIMEOUT = Object.freeze({ minSeconds: 10, defaultSeconds: 60, maxSeconds: 300 } as const);
export interface VoiceRequest {
  model: VoiceModel;
  text: string;
  stream: false;
  voice_setting: {
    voice_id: string;
    speed: number;
    vol: number;
    pitch: number;
    emotion?: Emotion;
  };
  audio_setting: {
    sample_rate: 32000;
    bitrate: 128000;
    format: "mp3";
    channel: 1;
  };
}
export interface VoiceExtraInfo {
  audioLength?: number;
  audioSampleRate?: number;
  audioSize?: number;
  bitrate?: number;
  wordCount?: number;
  usageCharacters?: number;
  audioFormat?: string;
  audioChannel?: number;
}
export interface VoiceResponse {
  audio: Buffer;
  extraInfo?: VoiceExtraInfo;
  traceId?: string;
}
