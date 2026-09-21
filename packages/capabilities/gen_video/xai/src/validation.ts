import { Value } from "typebox/value";
import type { ImageSource } from "../../../gen_image/xai/src/schema.ts";
import { VideoSchema, type VideoArgs } from "./schema.ts";
import {
  IMAGE_TO_VIDEO_DURATIONS,
  REFERENCE_DURATION,
  VIDEO_DEFAULTS,
  VIDEO_LIMITS,
  type VideoMode,
} from "./types.ts";

export function videoMode(args: VideoArgs): VideoMode {
  const hasRefs =
    (args.images?.length ?? 0) > 0 ||
    (args.voices?.length ?? 0) > 0 ||
    args.last_frame !== undefined ||
    (args.keyframes?.length ?? 0) > 0;
  return args.image && !hasRefs ? "image_to_video" : "reference_to_video";
}

function requireOneSource(source: ImageSource, label: string): void {
  if (Number(source.path !== undefined) + Number(source.image_url !== undefined) !== 1) {
    throw new Error(`${label} needs exactly one of path or image_url.`);
  }
}

export function validateVideoArgs(args: VideoArgs): VideoMode {
  if (!Value.Check(VideoSchema, args))
    throw new Error("Invalid gen_video arguments. Use the current tool schema.");
  const sources: [ImageSource | undefined, string][] = [
    [args.image, "image"],
    [args.last_frame, "last_frame"],
    ...(args.images ?? []).map((source, i) => [source, `images[${i}]`] as [ImageSource, string]),
    ...(args.keyframes ?? []).map(
      (frame, i) => [frame.image, `keyframes[${i}].image`] as [ImageSource, string],
    ),
  ];
  for (const [source, label] of sources) if (source) requireOneSource(source, label);
  const mode = videoMode(args);
  if (mode === "image_to_video") {
    if (
      args.duration !== undefined &&
      !(IMAGE_TO_VIDEO_DURATIONS as readonly number[]).includes(args.duration)
    ) {
      throw new Error("`duration` for image-to-video must be 6 or 10 seconds.");
    }
    return mode;
  }
  if (!args.prompt?.trim()) throw new Error("`prompt` is required for reference-to-video.");
  if (
    !args.image &&
    !args.images?.length &&
    !args.voices?.length &&
    !args.last_frame &&
    !args.keyframes?.length
  ) {
    throw new Error(
      "Provide at least one input: `image` (source or first frame), `images` (up to 14), `voices` (up to 3), `last_frame`, and/or `keyframes` (up to 4).",
    );
  }
  if ((args.voices ?? []).some((voice) => !voice.trim()))
    throw new Error('`voices` entries must be non-empty identifiers (e.g. "ara").');
  if (args.aspect_ratio === undefined) throw new Error("`aspect_ratio` is required for reference-to-video.");
  const duration = args.duration ?? VIDEO_DEFAULTS.duration;
  if (duration < REFERENCE_DURATION.minSeconds || duration > REFERENCE_DURATION.maxSeconds) {
    throw new Error(
      `\`duration\` must be between ${REFERENCE_DURATION.minSeconds} and ${REFERENCE_DURATION.maxSeconds} seconds.`,
    );
  }
  if ((args.keyframes?.length ?? 0) > VIDEO_LIMITS.keyframes)
    throw new Error(`\`keyframes\` must contain at most ${VIDEO_LIMITS.keyframes} anchors.`);
  for (const frame of args.keyframes ?? []) {
    const t = frame.timestamp_s;
    if (!Number.isFinite(t) || t <= 0 || t >= duration) {
      throw new Error(
        `\`keyframes\` timestamp ${t}s must be strictly inside the clip (0 < t < ${duration}s). Pin the endpoints with \`image\` / \`last_frame\` instead.`,
      );
    }
  }
  return mode;
}
