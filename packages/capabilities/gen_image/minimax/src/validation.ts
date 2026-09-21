import { IMAGE_MODELS, ASPECT_RATIOS, type ImageRequest } from "./types.ts";
import { requireText } from "../../../../transports/openai/src/validation.ts";

export function validateImageRequest(request: ImageRequest): void {
  requireText(request.prompt, "prompt", 1500);
  const allowed = new Set([
    "model",
    "prompt",
    "n",
    "response_format",
    "aspect_ratio",
    "prompt_optimizer",
    "seed",
  ]);
  for (const key of Object.keys(request))
    if (!allowed.has(key)) throw new Error(`Unsupported image parameter: ${key}.`);
  if (request.model !== undefined && !IMAGE_MODELS.includes(request.model))
    throw new Error("Invalid MiniMax image model.");
  if (request.n !== undefined && request.n !== 1) throw new Error("Exactly one image per call is fixed.");
  if (request.response_format !== undefined && request.response_format !== "base64")
    throw new Error("response_format is fixed to base64 internally.");
  if (request.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(request.aspect_ratio))
    throw new Error(`aspect_ratio must be one of: ${ASPECT_RATIOS.join(", ")}.`);
  if (request.seed !== undefined && !Number.isSafeInteger(request.seed))
    throw new Error("seed must be an integer.");
}
