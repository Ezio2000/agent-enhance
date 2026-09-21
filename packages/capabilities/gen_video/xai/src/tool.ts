import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { annotateError } from "../../../../core/src/errors.ts";
import { resolveImage } from "../../../gen_image/xai/src/artifacts.ts";
import { formatElapsed, promptSnippetText } from "../../../gen_image/xai/src/tool.ts";
import { VideoArtifactStore } from "./artifacts.ts";
import { VideoClient } from "./client.ts";
import { VideoSchema, type VideoArgs } from "./schema.ts";
import {
  VIDEO_DEFAULTS,
  VIDEO_MODEL,
  VIDEO_TIMEOUT,
  type VideoImageUrl,
  type VideoMode,
  type VideoRequest,
} from "./types.ts";
import { validateVideoArgs, videoMode } from "./validation.ts";

export interface VideoDependencies {
  client(ctx: ExecutionContext): VideoClient;
  artifacts: VideoArtifactStore;
}

async function resolveUrl(
  source: { path?: string; image_url?: string },
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await resolveImage(source, cwd, signal)).url;
}

export function videoWireOptions(
  args: VideoArgs,
  resolved: {
    image?: string;
    referenceImages: string[];
    lastFrame?: string;
    keyframes: { url: string; timestamp_s: number }[];
    voices: string[];
  },
): VideoRequest {
  const mode = videoMode(args);
  const image = resolved.image ? ({ url: resolved.image } satisfies VideoImageUrl) : undefined;
  return {
    model: VIDEO_MODEL,
    prompt: mode === "image_to_video" ? (args.prompt ?? "") : args.prompt!.trim(),
    duration: args.duration ?? VIDEO_DEFAULTS.duration,
    resolution: args.resolution ?? VIDEO_DEFAULTS.resolution,
    ...(image ? { image } : {}),
    ...(mode === "reference_to_video" && args.aspect_ratio ? { aspect_ratio: args.aspect_ratio } : {}),
    ...(resolved.referenceImages.length
      ? { reference_images: resolved.referenceImages.map((url) => ({ url })) }
      : {}),
    ...(resolved.voices.length
      ? { reference_audios: resolved.voices.map((voice_id) => ({ voice_id })) }
      : {}),
    ...(resolved.lastFrame ? { last_frame: { url: resolved.lastFrame } } : {}),
    ...(resolved.keyframes.length
      ? {
          keyframes: resolved.keyframes.map((frame) => ({
            image: { url: frame.url },
            timestamp_s: frame.timestamp_s,
          })),
        }
      : {}),
  };
}

export function videoTool(
  deps: VideoDependencies,
): ToolDefinition<typeof VideoSchema, Record<string, unknown>> {
  return {
    name: "gen_video",
    label: "Grok Video",
    description:
      "Generate one mp4 with Grok Imagine Video using the configured xAI credentials, independently of the main model provider. Two modes share this tool. Image-to-video: pass `image` (local PNG/JPEG/WebP path or HTTP(S)/data URL) and optionally `prompt`; duration is 6 or 10 seconds (default 6); aspect ratio follows the source and is omitted. Reference-to-video: required `prompt` plus at least one of `image` (literal first frame), `images` (up to 14 style/content refs), `voices` (up to 3), `last_frame`, or `keyframes` (up to 4 interior pins); required `aspect_ratio`; duration 1–15 seconds (default 6). Resolution 480p (default) or 720p. Model grok-imagine-video-1.5 is fixed. Inspect references before use. Saves the original mp4 locally. Each call returns one video, can take several minutes, and consumes account quota. Requests are not automatically retried.",
    promptSnippet: "Generate videos with Grok Imagine from a source image or references/voices/keyframes",
    promptGuidelines: [
      "Use gen_video when the user requests Grok video generation. Animate a single photo with `image`; use `images`/`voices`/`last_frame`/`keyframes` for reference-to-video and then required `aspect_ratio`.",
      "Do not claim a video was generated if the tool failed. Refer to the saved path; do not re-read or narrate the clip.",
    ],
    parameters: VideoSchema,
    async execute(_callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      const mode: VideoMode = validateVideoArgs(args);
      const image = args.image ? await resolveUrl(args.image, ctx.cwd, signal) : undefined;
      const referenceImages: string[] = [];
      for (const source of args.images ?? []) referenceImages.push(await resolveUrl(source, ctx.cwd, signal));
      const lastFrame = args.last_frame ? await resolveUrl(args.last_frame, ctx.cwd, signal) : undefined;
      const keyframes: { url: string; timestamp_s: number }[] = [];
      for (const frame of args.keyframes ?? [])
        keyframes.push({
          url: await resolveUrl(frame.image, ctx.cwd, signal),
          timestamp_s: frame.timestamp_s,
        });
      const request = videoWireOptions(args, {
        image,
        referenceImages,
        lastFrame,
        keyframes,
        voices: args.voices ?? [],
      });
      const start = Date.now();
      const elapsed = () => (Date.now() - start) / 1000;
      const statusText = () =>
        [
          `Generating video with ${request.model}…`,
          `"${promptSnippetText(request.prompt || "(no prompt)")}"`,
          `⏱ ${formatElapsed(elapsed())}`,
        ].join("\n");
      const progress = () =>
        onUpdate?.({
          content: [{ type: "text", text: statusText() }],
          details: { status: "in_progress", mode, elapsedSeconds: elapsed() },
        });
      progress();
      const ticker = setInterval(progress, 1000);
      let result: Awaited<ReturnType<VideoClient["videos"]>>;
      try {
        result = await deps.client(ctx).videos(request, {
          signal,
          timeoutMs: (args.timeout_seconds ?? VIDEO_TIMEOUT.defaultSeconds) * 1000,
        });
      } catch (error) {
        throw annotateError(
          error,
          `\nPrompt: "${promptSnippetText(request.prompt || "(no prompt)")}" · elapsed ${formatElapsed(elapsed())}`,
        );
      } finally {
        clearInterval(ticker);
      }
      const video = await deps.artifacts.saveVideo(ctx.sessionId, result.bytes, signal);
      return {
        content: [
          {
            type: "text",
            text: `Video: ${video.path} (${video.bytes} bytes)\n"${promptSnippetText(request.prompt || "(no prompt)")}" · ${request.model} · ${request.resolution} · elapsed ${formatElapsed(elapsed())}\nOriginal file is saved. Do not re-read or narrate the clip.`,
          },
        ],
        details: {
          version: 1,
          status: "completed",
          operation: mode,
          model: request.model,
          video,
          elapsedSeconds: elapsed(),
          requestId: result.requestId,
        },
      };
    },
  };
}
