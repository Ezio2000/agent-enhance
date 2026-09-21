export const VIDEO_MODEL = "grok-imagine-video-1.5" as const;
export const VIDEO_ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export const VIDEO_RESOLUTIONS = ["480p", "720p"] as const;
export const VIDEO_DEFAULTS = { model: VIDEO_MODEL, duration: 6, resolution: "480p" } as const;
export const IMAGE_TO_VIDEO_DURATIONS = [6, 10] as const;
export const REFERENCE_DURATION = { minSeconds: 1, maxSeconds: 15 } as const;
export const VIDEO_LIMITS = { images: 14, voices: 3, keyframes: 4 } as const;
export const VIDEO_TIMEOUT = {
  minSeconds: 10,
  defaultSeconds: 300,
  maxSeconds: 600,
  downloadSeconds: 120,
} as const;
export const VIDEO_POLL_INTERVAL_MS = 5000;

export type VideoMode = "image_to_video" | "reference_to_video";
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export interface VideoImageUrl {
  url: string;
}
export interface VideoVoiceId {
  voice_id: string;
}
export interface VideoKeyframePayload {
  image: VideoImageUrl;
  timestamp_s: number;
}
export interface VideoRequest {
  model: typeof VIDEO_MODEL;
  prompt: string;
  duration: number;
  resolution: VideoResolution;
  image?: VideoImageUrl;
  aspect_ratio?: VideoAspectRatio;
  reference_images?: VideoImageUrl[];
  reference_audios?: VideoVoiceId[];
  last_frame?: VideoImageUrl;
  keyframes?: VideoKeyframePayload[];
}
export interface VideoStartResponse {
  request_id?: string;
}
export interface VideoPollResponse {
  status?: string;
  video?: { url?: string };
}
