import { readFile } from "node:fs/promises";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { annotateError } from "../../../../core/src/errors.ts";
import { ImageArtifactStore, resolveImage } from "./artifacts.ts";
import { ImageClient } from "./client.ts";
import { ImageSchema, type ImageArgs } from "./schema.ts";
import { IMAGE_DEFAULTS, IMAGE_TIMEOUT, type ImageReference, type ImageRequest } from "./types.ts";
import { validateImageArgs } from "./validation.ts";

export interface ImageDependencies {
  client(ctx: ExecutionContext): ImageClient;
  artifacts: ImageArtifactStore;
  preview?(bytes: Uint8Array, mimeType: string): Promise<{ data: string; mimeType: string } | null>;
}

const PROMPT_SNIPPET_LENGTH = 60;

export function promptSnippetText(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > PROMPT_SNIPPET_LENGTH ? `${flat.slice(0, PROMPT_SNIPPET_LENGTH)}…` : flat;
}
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

export function imageWireOptions(args: ImageArgs, references: ImageReference[] = []): ImageRequest {
  return {
    ...IMAGE_DEFAULTS,
    model: args.model ?? IMAGE_DEFAULTS.model,
    prompt: args.prompt,
    resolution: args.resolution ?? IMAGE_DEFAULTS.resolution,
    ...(args.aspect_ratio === undefined ? {} : { aspect_ratio: args.aspect_ratio }),
    ...(args.quality === undefined ? {} : { quality: args.quality }),
    ...(references.length === 1
      ? { image: references[0] }
      : references.length > 1
        ? { images: references }
        : {}),
  };
}

export function imageTool(
  deps: ImageDependencies,
): ToolDefinition<typeof ImageSchema, Record<string, unknown>> {
  return {
    name: "gen_image",
    label: "Grok Image",
    description:
      "Generate or edit one image with Grok Imagine using the configured xAI credentials, independently of the main model provider. Omit images for generation; pass up to five explicit local PNG/JPEG/WebP paths or public/data URLs for editing. No conversation images are read automatically. Default model grok-imagine-image-2.0; older grok-imagine-image-quality and grok-imagine-image are selectable. Supports aspect ratio and 1k/2k resolution. quality (auto/low/medium) is only available for image-2.0. Inspect references before editing and describe what must remain unchanged. Saves the original and returns a smaller preview; use original paths for subsequent edits. Each call returns one image, can take several minutes, and consumes account quota. Requests are not automatically retried.",
    promptSnippet: "Generate/edit images with Grok Imagine, including reference images",
    promptGuidelines: [
      "Use gen_image when the user requests Grok image generation or editing. Pass explicit original paths for follow-up edits. Do not claim an image was generated if the tool failed.",
    ],
    parameters: ImageSchema,
    async execute(_callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      validateImageArgs(args);
      const references: ImageReference[] = [];
      for (const source of args.images ?? []) references.push(await resolveImage(source, ctx.cwd, signal));
      const request = imageWireOptions(args, references);
      const operation = references.length ? "edit" : "generate";
      const start = Date.now();
      const elapsed = () => (Date.now() - start) / 1000;
      const statusText = () =>
        [
          `${operation === "edit" ? "Editing" : "Generating"} image with ${request.model}…`,
          `"${promptSnippetText(args.prompt)}"`,
          `⏱ ${formatElapsed(elapsed())}`,
        ].join("\n");
      const progress = () =>
        onUpdate?.({
          content: [{ type: "text", text: statusText() }],
          details: { status: "in_progress", elapsedSeconds: elapsed() },
        });
      progress();
      const ticker = setInterval(progress, 1000);
      let result: Awaited<ReturnType<ImageClient["images"]>>;
      try {
        result = await deps.client(ctx).images(request, {
          signal,
          timeoutMs: (args.timeout_seconds ?? IMAGE_TIMEOUT.defaultSeconds) * 1000,
        });
      } catch (error) {
        throw annotateError(
          error,
          `\nPrompt: "${promptSnippetText(request.prompt)}" · elapsed ${formatElapsed(elapsed())}`,
        );
      } finally {
        clearInterval(ticker);
      }
      const image = await deps.artifacts.saveImage(ctx.sessionId, result.data.data[0]!.b64_json, signal);
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] =
        [
          {
            type: "text",
            text: `Image 1: ${image.path}${image.width ? ` (${image.width}x${image.height})` : ""}\n"${promptSnippetText(request.prompt)}" · ${request.model} · elapsed ${formatElapsed(elapsed())}\nOriginal files are saved. Previews may be resized; use original paths for subsequent edits.`,
          },
        ];
      if (deps.preview) {
        try {
          const preview = await deps.preview(await readFile(image.path), image.mimeType);
          if (preview) content.push({ type: "image", ...preview });
        } catch {
          /* A preview failure must not discard a saved original. */
        }
      }
      return {
        content,
        details: {
          version: 1,
          status: "completed",
          operation,
          model: request.model,
          images: [image],
          elapsedSeconds: elapsed(),
          requestId: result.requestId,
          usage: result.data.usage,
        },
      };
    },
  };
}
