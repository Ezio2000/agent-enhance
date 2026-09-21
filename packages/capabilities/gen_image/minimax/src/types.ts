export const IMAGE_MODELS = ["image-01"] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
export const ASPECT_RATIOS = ["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"] as const;
// Verified live: base64 arrives in data.image_base64[]; url format in data.image_urls[].
// base64 avoids a second signed-CDN fetch, so it is fixed internally.
export const IMAGE_DEFAULTS = Object.freeze({
  model: "image-01",
  n: 1,
  response_format: "base64",
} as const);
export const IMAGE_TIMEOUT = Object.freeze({ minSeconds: 10, defaultSeconds: 180, maxSeconds: 600 } as const);
export const PROMPT_MAX_CHARS = 1500;
export interface ImageRequest {
  model: ImageModel;
  prompt: string;
  n: 1;
  response_format: "base64";
  aspect_ratio?: (typeof ASPECT_RATIOS)[number];
  prompt_optimizer?: boolean;
  seed?: number;
}
export interface ImageResponse {
  imageBase64: string[];
  metadata?: { success_count?: string; failed_count?: string };
}
export interface QuotaInfo {
  plan?: string;
  intervalRemainingPercent?: number;
  intervalRemainsMs?: number;
  weeklyRemainingPercent?: number;
}
