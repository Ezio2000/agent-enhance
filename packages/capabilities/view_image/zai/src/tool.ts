import { readFile } from "node:fs/promises";
import { Value } from "typebox/value";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { VisionClient, type ContentPart, type VisionMessage } from "./client.ts";
import {
  UI_TO_ARTIFACT_PROMPTS,
  EXTRACT_TEXT_PROMPT,
  DIAGNOSE_ERROR_PROMPT,
  UNDERSTAND_DIAGRAM_PROMPT,
  ANALYZE_CHART_PROMPT,
  UI_DIFF_CHECK_PROMPT,
  IMAGE_ANALYSIS_PROMPT,
} from "./prompts.ts";
import { ViewImageSchema, type Task, type ViewImageArgs } from "./schema.ts";

type Details = Record<string, unknown>;
export interface ViewImageDependencies {
  client(ctx: ExecutionContext): VisionClient;
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const VISION_MODEL = "glm-5.3-flash";

export function systemPrompt(task: Task, args: ViewImageArgs): string {
  switch (task) {
    case "ui_to_artifact":
      return UI_TO_ARTIFACT_PROMPTS[args.output_type ?? ""] ?? "";
    case "extract_text":
      return EXTRACT_TEXT_PROMPT;
    case "diagnose_error":
      return DIAGNOSE_ERROR_PROMPT;
    case "understand_diagram":
      return UNDERSTAND_DIAGRAM_PROMPT;
    case "analyze_chart":
      return ANALYZE_CHART_PROMPT;
    case "ui_diff_check":
      return UI_DIFF_CHECK_PROMPT;
    default:
      return IMAGE_ANALYSIS_PROMPT;
  }
}

function ext(path: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match?.[1]?.toLowerCase() ?? "";
}

async function mediaPart(
  source: { path?: string; url?: string },
  kind: "image" | "video",
): Promise<ContentPart> {
  if (source.url && /^https?:\/\//i.test(source.url))
    return kind === "image"
      ? { type: "image_url", image_url: { url: source.url } }
      : { type: "video_url", video_url: { url: source.url } };
  if (!source.path) throw new Error(`Provide either path or url for the ${kind}.`);
  const extension = ext(source.path);
  const mime = kind === "image" ? IMAGE_MIME[extension] : VIDEO_MIME[extension];
  if (!mime)
    throw new Error(
      `Unsupported ${kind} extension .${extension || "(none)"}; expected ${kind === "image" ? "png/jpg/jpeg/webp/gif/bmp" : "mp4/mov/m4v/webm"}.`,
    );
  const bytes = await readFile(source.path);
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (bytes.length > limit) throw new Error(`${kind} exceeds ${limit / 1024 / 1024} MB (${source.path}).`);
  return {
    type: kind === "image" ? "image_url" : "video_url",
    [kind === "image" ? "image_url" : "video_url"]: {
      url: `data:${mime};base64,${bytes.toString("base64")}`,
    },
  } as ContentPart;
}

export function viewImageTool(deps: ViewImageDependencies): ToolDefinition<typeof ViewImageSchema, Details> {
  return {
    name: "view_image",
    label: "Zai Vision",
    description:
      "Analyze a local or remote image (or a video for video_analysis) with GLM multimodal vision through the GLM Coding Plan. Tasks: ui_to_artifact (UI screenshot to code/prompt/spec/description; needs output_type), extract_text (OCR), diagnose_error (error-screenshot diagnosis), understand_diagram (technical/flow diagrams), analyze_chart (data visualizations), ui_diff_check (compare two UI images; needs image and image2), image_analysis (general), video_analysis (needs a video source). Billing shares the GLM Coding Plan subscription quota per token. The tool is only registered while the active model cannot read images itself.",
    promptSnippet: "Read local images (and videos) via GLM vision when the active model is text-only",
    promptGuidelines: [
      "Use view_image to inspect screenshots, diagrams, charts or videos when the active model cannot read images directly; pick the task matching the content.",
    ],
    parameters: ViewImageSchema,
    async execute(_callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(ViewImageSchema, args))
        throw new Error("Invalid view_image arguments; use the current tool schema.");
      const task = args.task as Task;
      const wantsVideo = task === "video_analysis";
      const primary = args.image;
      if (!primary)
        throw new Error(`Provide image (path or url; video files for video_analysis) for task ${task}.`);
      if (task === "ui_to_artifact" && !args.output_type)
        throw new Error("ui_to_artifact requires output_type: code, prompt, spec or description.");
      if (task === "ui_diff_check" && !args.image2)
        throw new Error("ui_diff_check requires image2 (the actual state) alongside image (expected).");
      if (task !== "ui_diff_check" && args.image2)
        throw new Error("image2 is only accepted with ui_diff_check.");
      const sourceRef = primary.path ?? primary.url ?? "";
      if (task !== "video_analysis" && ext(sourceRef) in VIDEO_MIME)
        throw new Error("Videos are only accepted with task video_analysis.");

      const system = systemPrompt(task, args);
      if (!system) throw new Error(`No system prompt available for output_type ${args.output_type}.`);
      const parts: ContentPart[] = [await mediaPart(primary, wantsVideo ? "video" : "image")];
      if (task === "ui_diff_check" && args.image2) parts.push(await mediaPart(args.image2, "image"));
      const hints: string[] = [];
      if (args.language) hints.push(`<language_hint>The code is in ${args.language}.</language_hint>`);
      if (args.diagram_type)
        hints.push(`<diagram_type_hint>The diagram type is ${args.diagram_type}.</diagram_type_hint>`);
      if (args.context) hints.push(`<context>${args.context}</context>`);
      const messages: VisionMessage[] = [
        { role: "system", content: system },
        {
          role: "user",
          content: [...parts, { type: "text", text: [args.prompt, ...hints].join("\n\n") }],
        },
      ];
      onUpdate?.({
        content: [{ type: "text", text: `Analyzing ${task} with ${VISION_MODEL}…` }],
        details: { status: "in_progress" },
      });
      const result = await deps.client(ctx).analyze(
        {
          model: VISION_MODEL,
          messages,
          thinking: { type: args.thinking === "disabled" ? "disabled" : "enabled" },
          max_tokens: args.max_tokens ?? 4096,
          stream: false,
        },
        { signal, timeoutMs: (args.timeout_seconds ?? 180) * 1000 },
      );
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: result.content }],
        details: {
          version: 1,
          status: "completed",
          task,
          model: result.model,
          thinking: args.thinking === "disabled" ? "disabled" : "enabled",
          finishReason: result.finishReason,
          usage: {
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            reasoningTokens: result.usage.completion_tokens_details?.reasoning_tokens,
            totalTokens: result.usage.total_tokens,
          },
          requestId: result.requestId,
        },
      };
    },
  };
}
