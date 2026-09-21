import { Type, type Static } from "typebox";
import { object, text, choices } from "../../../../transports/zai/src/schema.ts";

export const TASKS = [
  "ui_to_artifact",
  "extract_text",
  "diagnose_error",
  "understand_diagram",
  "analyze_chart",
  "ui_diff_check",
  "image_analysis",
  "video_analysis",
] as const;
export type Task = (typeof TASKS)[number];

const source = (label: string) =>
  object({
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description: `Local ${label} path (png/jpg/jpeg/webp/gif/bmp${label === "video" ? "/mp4/mov/m4v/webm" : ""}); relative paths use the current working directory`,
      }),
    ),
    url: Type.Optional(Type.String({ minLength: 1, description: `Public HTTP(S) URL of the ${label}` })),
  });

export const ViewImageSchema = object({
  task: choices([...TASKS], "Analysis task; determines the specialist system prompt"),
  prompt: text("Task instructions: what to extract, generate, compare or answer", 8000),
  image: Type.Optional(source("image (or the video file/URL for video_analysis)")),
  image2: Type.Optional(source("second image (actual state); required with ui_diff_check")),
  output_type: Type.Optional(
    choices(["code", "prompt", "spec", "description"], "Required with ui_to_artifact"),
  ),
  language: Type.Optional(text("Programming-language hint for extract_text", 60)),
  diagram_type: Type.Optional(
    text("Diagram hint for understand_diagram, e.g. architecture/flowchart/uml/er-diagram/sequence", 60),
  ),
  context: Type.Optional(text("When/how the error occurred, for diagnose_error", 500)),
  thinking: Type.Optional(
    choices(["enabled", "disabled"], "Default enabled; disable for cheap mechanical reads like plain OCR"),
  ),
  max_tokens: Type.Optional(
    Type.Integer({ minimum: 64, maximum: 32768, description: "Output budget; default 4096" }),
  ),
  timeout_seconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 600, description: "Default 180" })),
});
export type ViewImageArgs = Static<typeof ViewImageSchema>;
