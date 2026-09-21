export const IMAGE_MODELS = [
  "grok-imagine-image-2.0",
  "grok-imagine-image-quality",
  "grok-imagine-image",
] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
export const ASPECT_RATIOS = [
  "auto",
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;
export const IMAGE_DEFAULTS = {
  model: "grok-imagine-image-2.0",
  resolution: "1k",
  n: 1,
  response_format: "b64_json",
} as const;
export const IMAGE_TIMEOUT = { minSeconds: 10, defaultSeconds: 300, maxSeconds: 600 } as const;
export interface ImageReference {
  type: "image_url";
  url: string;
}
export interface ImageRequest {
  model: ImageModel;
  prompt: string;
  n: 1;
  response_format: "b64_json";
  resolution: "1k" | "2k";
  aspect_ratio?: (typeof ASPECT_RATIOS)[number];
  quality?: "auto" | "low" | "medium";
  image?: ImageReference;
  images?: ImageReference[];
}
export interface ImageResponse {
  data: { b64_json: string; revised_prompt?: string }[];
  usage?: Record<string, unknown>;
}
