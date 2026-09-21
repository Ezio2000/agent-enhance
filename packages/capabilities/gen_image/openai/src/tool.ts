import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { annotateError } from "../../../../core/src/errors.ts";
import { ImageArtifactStore, MAX_IMAGE_BYTES, MAX_TOTAL_INPUT_BYTES, resolveImage } from "./artifacts.ts";
import { ImageClient } from "./client.ts";
import {
  IMAGE_DEFAULTS,
  IMAGE_MAX_REFERENCES,
  IMAGE_TIMEOUT,
  type ImageRequest,
  type QuotaInfo,
} from "./types.ts";
import { validateImageRequest } from "./validation.ts";
import { imageWarnings } from "./warnings.ts";
import { ImageSchema, type ImageArgs } from "./schema.ts";

type Details = Record<string, unknown>;
interface Preview {
  data: string;
  mimeType: string;
}
// Cap on inline previews returned to the model; originals on disk are always the full set.
const MAX_PREVIEWS = 4;
const PROMPT_SNIPPET_LENGTH = 60;

export function promptSnippetText(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_SNIPPET_LENGTH ? `${flat.slice(0, PROMPT_SNIPPET_LENGTH)}…` : flat;
}
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}
export function formatResetIn(resetAt: number, now = Date.now()): string {
  const total = Math.max(0, Math.round((resetAt - now) / 1000));
  const days = Math.floor(total / 86400),
    hours = Math.floor((total % 86400) / 3600),
    minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
// Empty string when the backend did not send Codex quota headers; callers skip the line entirely.
export function quotaLine(quota?: QuotaInfo, now?: number): string {
  if (!quota || quota.usedPercent === undefined) return "";
  const parts = [`quota ${quota.usedPercent}% used`];
  if (quota.resetAt !== undefined) parts.push(`resets in ${formatResetIn(quota.resetAt, now)}`);
  return parts.join(" · ");
}
export interface ImageDependencies {
  client(ctx: ExecutionContext): ImageClient;
  artifacts: ImageArtifactStore;
  preview?(bytes: Uint8Array, mimeType: string): Promise<Preview | null>;
}

export function imageWireOptions(args: ImageArgs): ImageRequest {
  return {
    ...IMAGE_DEFAULTS,
    model: args.model ?? IMAGE_DEFAULTS.model,
    prompt: args.prompt,
    size: args.size ?? "auto",
    background: args.background ?? "auto",
    quality: args.quality ?? IMAGE_DEFAULTS.quality,
    moderation: IMAGE_DEFAULTS.moderation,
  };
}

export function imageTool(deps: ImageDependencies): ToolDefinition<typeof ImageSchema, Details> {
  return {
    name: "gen_image",
    label: "OpenAI Image",
    description: `Generate or edit images with OpenAI GPT Image over the Codex HTTP endpoint. No images means generation; explicit images means editing. Conversation context images are never read, so every request is independent. Supports local paths, image URLs/data URLs, size, background and quality. Quality defaults to auto. Moderation is fixed internally to ${IMAGE_DEFAULTS.moderation} (requests less restrictive filtering, not disabled safety policies; backend effect is unverified) and is not a tool argument. Model is selectable: gpt-image-2.5-flare (default, fast everyday generation), gpt-image-2.5-sunburst (editing precision), or gpt-image-2. Backend model routing is not independently verifiable. Fixed internally: one image, PNG, SSE with no requested partial images; these fixed fields are not tool arguments. Requested dimensions may not be honored; observable mismatches are reported. Input files must be PNG/JPEG/WebP under ${(MAX_IMAGE_BYTES + 1) / 1_000_000} MB each, at most ${IMAGE_MAX_REFERENCES} images and ${MAX_TOTAL_INPUT_BYTES / (1024 * 1024)} MiB combined. Inspect local reference images with read before editing. Specify exactly one image source per item. Preserve unchanged details explicitly in the prompt. Generated originals are saved locally; small inline previews may be included alongside. Reuse original saved paths for later edits. Requests can take several minutes, consume image quota, and are never automatically retried.`,
    promptSnippet: "Generate/edit images using OpenAI GPT Image, including reference images",
    promptGuidelines: [
      "Use gen_image for requested image generation or editing. Prefer saved original image paths for follow-up edits; do not claim an image was produced if the tool failed.",
      "Each gen_image call produces exactly one image. For batches, issue multiple gen_image calls in parallel within the same turn; 8 to 16 concurrent calls are safe and encouraged, do not artificially cap batches at 4.",
    ],
    parameters: ImageSchema,
    async execute(callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(ImageSchema, args))
        throw new Error(
          "Invalid gen_image arguments; unsupported or fixed parameters are rejected and this build never reads conversation context images. Use the current tool schema.",
        );
      // Context images are deliberately never read: pass explicit independent references, or generate without references.
      const sources = args.images ?? [];
      // Resolve sequentially so a batch cannot trigger unbounded parallel file reads.
      const resolved = [];
      let inputBytes = 0;
      for (const source of sources) {
        const image = await resolveImage(source, ctx.cwd, signal);
        inputBytes += image.bytes?.length ?? 0;
        if (inputBytes > MAX_TOTAL_INPUT_BYTES)
          throw new Error("Combined image inputs exceed the 100 MiB safety limit.");
        resolved.push(image);
      }
      const request: ImageRequest = {
        ...imageWireOptions(args),
        images: resolved.length ? resolved.map((image) => image.reference) : undefined,
      };
      validateImageRequest(request);
      const startedAt = Date.now();
      const elapsedSeconds = () => (Date.now() - startedAt) / 1000;
      let quota: QuotaInfo | undefined;
      const statusText = () =>
        [
          `${request.images ? "Editing" : "Generating"} image(s) with ${request.model}…`,
          `"${promptSnippetText(request.prompt)}"`,
          [`⏱ ${formatElapsed(elapsedSeconds())}`, quotaLine(quota)].filter(Boolean).join(" · "),
        ].join("\n");
      const progressUpdate = () => ({
        content: [{ type: "text" as const, text: statusText() }],
        details: { status: "in_progress", elapsedSeconds: elapsedSeconds(), ...(quota ? { quota } : {}) },
      });
      onUpdate?.(progressUpdate());
      // 1s ticker keeps the timer moving; quota appears once response headers arrive.
      const ticker = setInterval(() => onUpdate?.(progressUpdate()), 1000);
      let result: Awaited<ReturnType<ImageClient["images"]>>;
      try {
        result = await deps.client(ctx).images(request, {
          signal,
          timeoutMs: (args.timeout_seconds ?? IMAGE_TIMEOUT.defaultSeconds) * 1000,
          turnId: callId,
          onProgress: (progress) => {
            if (progress.quota) {
              quota = progress.quota;
              return;
            }
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Received partial image${progress.index !== undefined ? ` ${progress.index + 1}` : ""}; waiting for the final image…`,
                },
              ],
              details: { status: "in_progress", partialImageIndex: progress.index },
            });
          },
        });
        if (result.quota) quota = result.quota;
      } catch (error) {
        const context = [`elapsed ${formatElapsed(elapsedSeconds())}`, quotaLine(quota)]
          .filter(Boolean)
          .join(" · ");
        throw annotateError(error, `\nPrompt: "${promptSnippetText(request.prompt)}" · ${context}`);
      } finally {
        clearInterval(ticker);
      }
      signal?.throwIfAborted();
      const images = await deps.artifacts.saveImages(ctx.sessionId, result.data.data, signal);
      const warnings = imageWarnings(request, result.data, images);
      const summary = [
        `"${promptSnippetText(request.prompt)}"`,
        request.model,
        `elapsed ${elapsedSeconds().toFixed(1)}s`,
        quotaLine(quota),
      ]
        .filter(Boolean)
        .join(" · ");
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] =
        [
          {
            type: "text",
            text:
              images
                .map(
                  (image, i) =>
                    `Image ${i + 1}: ${image.path}${image.width ? ` (${image.width}x${image.height})` : ""}`,
                )
                .join("\n") +
              `\n${summary}` +
              "\nOriginal files are saved. Previews may be resized; use original paths for subsequent edits." +
              (warnings.length
                ? `\n\nBackend compatibility warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`
                : ""),
          },
        ];
      if (deps.preview) {
        for (const image of images.slice(0, MAX_PREVIEWS)) {
          signal?.throwIfAborted();
          try {
            const preview = await deps.preview(await readFile(image.path, { signal }), image.mimeType);
            if (preview && Buffer.byteLength(preview.data, "base64") <= 512 * 1024)
              content.push({ type: "image", ...preview });
          } catch {
            signal?.throwIfAborted();
            // A preview failure must not discard a successfully saved image.
          }
        }
      }
      return {
        content,
        details: {
          version: 1,
          status: "completed",
          model: request.model,
          operation: request.images ? "edit" : "generate",
          requestId: result.requestId,
          images,
          warnings,
          elapsedSeconds: elapsedSeconds(),
          ...(quota ? { quota } : {}),
          outputFormat: result.data.output_format,
          quality: result.data.quality,
          background: result.data.background,
          size: result.data.size,
          usage: result.data.usage,
        },
      };
    },
  };
}
