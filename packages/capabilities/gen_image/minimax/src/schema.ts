import { Type, type Static } from "typebox";
import { object, text, choices } from "../../../../transports/minimax/src/schema.ts";
import { ASPECT_RATIOS, IMAGE_MODELS, IMAGE_TIMEOUT, PROMPT_MAX_CHARS } from "./types.ts";

export const ImageSchema = object({
  prompt: text(
    `Detailed generation instructions, at most ${PROMPT_MAX_CHARS} characters. Editing/reference images are not supported by this provider.`,
    PROMPT_MAX_CHARS,
  ),
  model: Type.Optional(choices(IMAGE_MODELS, "Default image-01; the only verified Token Plan image model.")),
  aspect_ratio: Type.Optional(
    choices(ASPECT_RATIOS, "Output aspect ratio; default 1:1 (observed 1024x1024 JPEG)."),
  ),
  prompt_optimizer: Type.Optional(
    Type.Boolean({ description: "Let the backend rewrite the prompt before generating; default false." }),
  ),
  seed: Type.Optional(
    Type.Integer({ description: "Fixed seed for reproducible generations, if the backend honors it." }),
  ),
  timeout_seconds: Type.Optional(
    Type.Integer({
      minimum: IMAGE_TIMEOUT.minSeconds,
      maximum: IMAGE_TIMEOUT.maxSeconds,
      description: `Default ${IMAGE_TIMEOUT.defaultSeconds}. Generation is never automatically retried.`,
    }),
  ),
});
export type ImageArgs = Static<typeof ImageSchema>;
