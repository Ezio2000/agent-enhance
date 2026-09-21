import { Type, type Static } from "typebox";
import { object, text, choices } from "../../../../transports/openai/src/schema.ts";
import { IMAGE_MODELS, IMAGE_TIMEOUT, IMAGE_MAX_REFERENCES, IMAGE_SIZE_RULES } from "./types.ts";

const imageSource = object({
  path: Type.Optional(
    text("Local PNG/JPEG/WebP file to upload; relative to current working directory", 4096),
  ),
  image_url: Type.Optional(
    text(
      "HTTP(S) image URL, or data:image/png|jpeg|webp;base64,...; fetched by OpenAI, not this client",
      70000000,
    ),
  ),
});
export const ImageSchema = object({
  model: Type.Optional(
    choices(
      [...IMAGE_MODELS],
      "Default gpt-image-2.5-flare. Sunburst prioritizes editing precision; Flare prioritizes fast everyday generation. Backend model routing is not independently verifiable.",
    ),
  ),
  prompt: text(
    "Detailed generation/edit instructions. For edits, state what to preserve and what to change.",
    32000,
  ),
  images: Type.Optional(
    Type.Array(imageSource, {
      minItems: 1,
      maxItems: IMAGE_MAX_REFERENCES,
      description:
        "Edit/reference inputs. Exactly one of path or image_url per item. Omit to generate a new image.",
    }),
  ),
  size: Type.Optional(
    text(
      `auto or WIDTHxHEIGHT. All supported models: multiples of ${IMAGE_SIZE_RULES.multiple}, edges <=${IMAGE_SIZE_RULES.maxEdge}, ratio <=${IMAGE_SIZE_RULES.maxAspect}:1, ${IMAGE_SIZE_RULES.minPixels}–${IMAGE_SIZE_RULES.maxPixels} pixels.`,
      30,
    ),
  ),
  background: Type.Optional(
    choices(["auto", "opaque", "transparent"], "Default auto; transparent PNG output is supported"),
  ),
  quality: Type.Optional(
    choices(
      ["auto", "low", "medium", "high"],
      "Default auto. Backend may adjust quality; observable mismatches are reported.",
    ),
  ),
  timeout_seconds: Type.Optional(
    Type.Integer({
      minimum: IMAGE_TIMEOUT.minSeconds,
      maximum: IMAGE_TIMEOUT.maxSeconds,
      description: `Default ${IMAGE_TIMEOUT.defaultSeconds}. Image POSTs are never automatically retried.`,
    }),
  ),
});
export type ImageArgs = Static<typeof ImageSchema>;
export type ImageSource = Static<typeof imageSource>;
