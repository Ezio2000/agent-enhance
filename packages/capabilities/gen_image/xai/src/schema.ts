import { Type, type Static } from "typebox";
import { ASPECT_RATIOS, IMAGE_MODELS, IMAGE_TIMEOUT } from "./types.ts";

const choices = <T extends string>(values: readonly T[], description: string) =>
  Type.Unsafe<T>({ type: "string", enum: [...values], description });
export const imageSource = Type.Object(
  {
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Local PNG/JPEG/WebP path; relative paths use the current working directory.",
      }),
    ),
    image_url: Type.Optional(
      Type.String({ minLength: 1, description: "Public HTTP(S) URL or base64 data:image/... URL." }),
    ),
  },
  { additionalProperties: false },
);
export const ImageSchema = Type.Object(
  {
    prompt: Type.String({
      minLength: 1,
      maxLength: 32000,
      description:
        "Detailed generation instructions. For edits, explicitly describe what to preserve and change.",
    }),
    model: Type.Optional(choices(IMAGE_MODELS, "Default grok-imagine-image-2.0.")),
    images: Type.Optional(
      Type.Array(imageSource, {
        minItems: 1,
        maxItems: 5,
        description:
          "Reference images for editing. Exactly one of path or image_url per item. Omit for text-to-image.",
      }),
    ),
    aspect_ratio: Type.Optional(
      choices(
        ASPECT_RATIOS,
        "Output aspect ratio. Omit for automatic generation sizing or to follow the first reference image when editing.",
      ),
    ),
    resolution: Type.Optional(choices(["1k", "2k"], "Default 1k.")),
    quality: Type.Optional(
      choices(
        ["auto", "low", "medium"],
        "Only supported by grok-imagine-image-2.0. Default auto; omitted for older models.",
      ),
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: IMAGE_TIMEOUT.minSeconds,
        maximum: IMAGE_TIMEOUT.maxSeconds,
        description: "Default 300 seconds. Generation/edit requests are not automatically retried.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type ImageArgs = Static<typeof ImageSchema>;
export type ImageSource = Static<typeof imageSource>;
