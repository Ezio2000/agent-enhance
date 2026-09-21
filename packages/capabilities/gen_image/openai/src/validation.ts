import {
  IMAGE_MODELS,
  IMAGE_FIXED,
  IMAGE_DEFAULTS,
  IMAGE_MAX_REFERENCES,
  IMAGE_SIZE_RULES,
  type ImageReference,
  type ImageRequest,
} from "./types.ts";
import { requireText, integer } from "../../../../transports/openai/src/validation.ts";

export function validateReference(ref: ImageReference): void {
  if (Object.keys(ref).some((key) => key !== "image_url"))
    throw new Error("Image references only support image_url.");
  requireText(ref.image_url, "image_url", 70000000);
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(ref.image_url)) {
    const url = new URL(ref.image_url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error(
        "Image URL must be HTTP(S), without embedded credentials, or a PNG/JPEG/WebP data URL.",
      );
  }
}
export function validateImageRequest(request: ImageRequest): void {
  requireText(request.prompt, "prompt");
  const allowed = new Set([...Object.keys(IMAGE_DEFAULTS), "prompt", "images", "size", "background"]);
  for (const key of Object.keys(request))
    if (!allowed.has(key)) throw new Error(`Unsupported image parameter: ${key}.`);
  for (const key of Object.keys(IMAGE_FIXED) as (keyof typeof IMAGE_FIXED)[]) {
    if (request[key] !== undefined && request[key] !== IMAGE_FIXED[key])
      throw new Error(`${key} is fixed to ${IMAGE_FIXED[key]}.`);
  }
  if (request.model !== undefined && !IMAGE_MODELS.includes(request.model))
    throw new Error("Invalid image model.");
  if (request.quality !== undefined && !["auto", "low", "medium", "high"].includes(request.quality))
    throw new Error("Invalid image quality.");
  if (request.moderation !== undefined && !["auto", "low"].includes(request.moderation))
    throw new Error("Invalid image moderation.");
  if (request.background !== undefined && !["auto", "opaque", "transparent"].includes(request.background))
    throw new Error("Invalid image background.");
  if (request.images !== undefined) {
    integer(request.images.length, "images count", 1, IMAGE_MAX_REFERENCES);
    for (const ref of request.images) validateReference(ref);
  }
  if (request.size && request.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(request.size);
    if (!match) throw new Error("size must be auto or WIDTHxHEIGHT.");
    const w = Number(match[1]),
      h = Number(match[2]),
      pixels = w * h;
    const rules = IMAGE_SIZE_RULES;
    if (
      w <= 0 ||
      h <= 0 ||
      w % rules.multiple ||
      h % rules.multiple ||
      Math.max(w, h) > rules.maxEdge ||
      Math.max(w, h) / Math.min(w, h) > rules.maxAspect ||
      pixels < rules.minPixels ||
      pixels > rules.maxPixels
    ) {
      throw new Error(
        `GPT Image size: edges must be multiples of ${rules.multiple} and <=${rules.maxEdge}, aspect ratio <=${rules.maxAspect}:1, pixels ${rules.minPixels}–${rules.maxPixels}.`,
      );
    }
  }
}
