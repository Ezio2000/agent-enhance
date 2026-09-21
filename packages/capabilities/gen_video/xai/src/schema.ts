import { Type, type Static } from "typebox";
import { imageSource } from "../../../gen_image/xai/src/schema.ts";
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_LIMITS,
  VIDEO_RESOLUTIONS,
  VIDEO_TIMEOUT,
  REFERENCE_DURATION,
} from "./types.ts";

const choices = <T extends string>(values: readonly T[], description: string) =>
  Type.Unsafe<T>({ type: "string", enum: [...values], description });

export const VideoSchema = Type.Object(
  {
    prompt: Type.Optional(
      Type.String({
        maxLength: 32000,
        description:
          "Guide the animation or describe the desired video. Optional for image-to-video; required for reference-to-video. Tag style references as <IMAGE_i> and voices as <AUDIO_0> in upload order: image, images, keyframes, last_frame.",
      }),
    ),
    image: Type.Optional(imageSource),
    images: Type.Optional(
      Type.Array(imageSource, {
        minItems: 1,
        maxItems: VIDEO_LIMITS.images,
        description:
          "Style/content references (people, objects, clothing, settings) — they appear re-rendered, not as literal frames. Up to 14. Each item is exactly one of path or image_url.",
      }),
    ),
    last_frame: Type.Optional(imageSource),
    keyframes: Type.Optional(
      Type.Array(
        Type.Object(
          {
            image: imageSource,
            timestamp_s: Type.Number({
              description:
                "Time in seconds at which the image appears, strictly inside the clip (0 < t < duration). Snapped server-side to a 1/3-second grid.",
            }),
          },
          { additionalProperties: false },
        ),
        {
          minItems: 1,
          maxItems: VIDEO_LIMITS.keyframes,
          description: "Mid-clip literal frame pins, up to 4. Use image / last_frame for the endpoints.",
        },
      ),
    ),
    voices: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: VIDEO_LIMITS.voices,
        description:
          "Preset voice identifiers the subjects speak in, up to 3 (e.g. ara, eve, leo, rex). Tag them in the prompt as <AUDIO_0>.",
      }),
    ),
    aspect_ratio: Type.Optional(
      choices(
        VIDEO_ASPECT_RATIOS,
        "Required for reference-to-video. Omitted for image-to-video so the clip follows the source image.",
      ),
    ),
    duration: Type.Optional(
      Type.Integer({
        minimum: REFERENCE_DURATION.minSeconds,
        maximum: REFERENCE_DURATION.maxSeconds,
        description:
          "Image-to-video: 6 or 10 seconds (default 6). Reference-to-video: 1–15 seconds (default 6).",
      }),
    ),
    resolution: Type.Optional(
      choices(VIDEO_RESOLUTIONS, "Default 480p. Only set 720p when the user asks for higher quality."),
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: VIDEO_TIMEOUT.minSeconds,
        maximum: VIDEO_TIMEOUT.maxSeconds,
        description:
          "Start+poll deadline in seconds, default 300. Download has a separate 120s budget. Requests are not automatically retried.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type VideoArgs = Static<typeof VideoSchema>;
