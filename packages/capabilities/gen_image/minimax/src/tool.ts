import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import { annotateError } from "../../../../core/src/errors.ts";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { ImageArtifactStore } from "./artifacts.ts";
import { ImageClient } from "./client.ts";
import { ImageSchema, type ImageArgs } from "./schema.ts";
import { IMAGE_DEFAULTS, IMAGE_TIMEOUT } from "./types.ts";
import { validateImageRequest } from "./validation.ts";

type Details = Record<string, unknown>;
interface Preview {
  data: string;
  mimeType: string;
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

export interface ImageDependencies {
  client(ctx: ExecutionContext): ImageClient;
  artifacts: ImageArtifactStore;
  preview?(bytes: Uint8Array, mimeType: string): Promise<Preview | null>;
}

export function imageWireOptions(args: ImageArgs): ImageRequestWire {
  return {
    ...IMAGE_DEFAULTS,
    model: args.model ?? IMAGE_DEFAULTS.model,
    prompt: args.prompt,
    ...(args.aspect_ratio === undefined ? {} : { aspect_ratio: args.aspect_ratio }),
    ...(args.prompt_optimizer === undefined ? {} : { prompt_optimizer: args.prompt_optimizer }),
    ...(args.seed === undefined ? {} : { seed: args.seed }),
  };
}
type ImageRequestWire = Parameters<typeof validateImageRequest>[0];

export function imageTool(deps: ImageDependencies): ToolDefinition<typeof ImageSchema, Details> {
  return {
    name: "gen_image",
    label: "MiniMax Image",
    description: `Generate one image with MiniMax image-01 over the Token Plan channel (sk-cp key). Text-to-image only: this provider has no edit/reference-image support, so passing images is an error. Options under options.minimax: aspect_ratio (1:1 default, observed 1024x1024 JPEG output), prompt_optimizer, seed. The backend currently returns JPEG originals; the actual format is reported from the saved bytes. The daily image allowance is enforced server-side with its own quota, separate from the token window, and is not exposed by any quota API; hitting it surfaces error 2067. Each call produces exactly one image; for batches issue parallel calls. Requests are never automatically retried. Generated originals are saved locally; small inline previews may be included alongside. Reuse original saved paths with providers that support editing.`,
    promptSnippet: "Generate images with MiniMax image-01 via the Token Plan",
    promptGuidelines: [
      "Use gen_image with provider minimax for MiniMax image generation. Do not pass images for edits; this backend is generation-only. Do not claim an image was produced if the tool failed.",
    ],
    parameters: ImageSchema,
    async execute(callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(ImageSchema, args))
        throw new Error("Invalid gen_image arguments; use the current tool schema.");
      const request = imageWireOptions(args);
      validateImageRequest(request);
      const startedAt = Date.now();
      const elapsedSeconds = () => (Date.now() - startedAt) / 1000;
      const statusText = () =>
        [
          `Generating image with ${request.model}…`,
          `"${promptSnippetText(request.prompt)}"`,
          `⏱ ${formatElapsed(elapsedSeconds())}`,
        ].join("\n");
      const progressUpdate = () =>
        onUpdate?.({
          content: [{ type: "text" as const, text: statusText() }],
          details: { status: "in_progress", elapsedSeconds: elapsedSeconds() },
        });
      progressUpdate();
      const ticker = setInterval(progressUpdate, 1000);
      let result: Awaited<ReturnType<ImageClient["images"]>>;
      try {
        result = await deps.client(ctx).images(request, {
          signal,
          timeoutMs: (args.timeout_seconds ?? IMAGE_TIMEOUT.defaultSeconds) * 1000,
        });
      } catch (error) {
        throw annotateError(
          error,
          `\nPrompt: "${promptSnippetText(request.prompt)}" · elapsed ${formatElapsed(elapsedSeconds())}`,
        );
      } finally {
        clearInterval(ticker);
      }
      signal?.throwIfAborted();
      const image = await deps.artifacts.saveImage(ctx.sessionId, result.data.imageBase64[0]!, signal);
      const summary = [
        `"${promptSnippetText(request.prompt)}"`,
        request.model,
        `elapsed ${elapsedSeconds().toFixed(1)}s`,
      ]
        .filter(Boolean)
        .join(" · ");
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] =
        [
          {
            type: "text",
            text:
              `Image 1: ${image.path}${image.width ? ` (${image.width}x${image.height})` : ""}\n${summary}` +
              "\nOriginal file is saved. Previews may be resized; use the original path for subsequent operations.",
          },
        ];
      if (deps.preview) {
        try {
          const preview = await deps.preview(await readFile(image.path, { signal }), image.mimeType);
          if (preview && Buffer.byteLength(preview.data, "base64") <= 512 * 1024)
            content.push({ type: "image", ...preview });
        } catch {
          signal?.throwIfAborted();
          // A preview failure must not discard a successfully saved image.
        }
      }
      return {
        content,
        details: {
          version: 1,
          status: "completed",
          operation: "generate",
          model: request.model,
          images: [image],
          elapsedSeconds: elapsedSeconds(),
          requestId: result.requestId,
          metadata: result.data.metadata,
        },
      };
    },
  };
}
