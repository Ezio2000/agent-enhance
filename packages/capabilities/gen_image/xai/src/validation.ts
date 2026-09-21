import { Value } from "typebox/value";
import { ImageSchema, type ImageArgs } from "./schema.ts";
import { IMAGE_DEFAULTS } from "./types.ts";

export function validateImageArgs(args: ImageArgs): void {
  if (!Value.Check(ImageSchema, args))
    throw new Error(
      "Invalid gen_image arguments. Use the current tool schema; one output and base64 format are fixed internally.",
    );
  if (!args.prompt.trim()) throw new Error("Image prompt must not be blank.");
  if (args.quality !== undefined && (args.model ?? IMAGE_DEFAULTS.model) !== "grok-imagine-image-2.0") {
    throw new Error("quality is supported only by grok-imagine-image-2.0. Omit quality for older models.");
  }
  for (const source of args.images ?? []) {
    if (Number(source.path !== undefined) + Number(source.image_url !== undefined) !== 1)
      throw new Error("Each reference image needs exactly one of path or image_url.");
  }
}
