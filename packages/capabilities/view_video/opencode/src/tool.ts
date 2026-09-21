import { stat, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { Value } from "typebox/value";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { resolveOpencodeGoAuth } from "../../../../transports/opencode/src/auth.ts";
import { ResponsesClient, type ReasoningEffort } from "../../../../transports/opencode/src/responses.ts";
import { VideoSchema, type VideoArgs } from "./schema.ts";

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
};

export function videoTool(
  deps: { client(ctx: ExecutionContext): ResponsesClient } = {
    client: (ctx) => new ResponsesClient(() => resolveOpencodeGoAuth(ctx)),
  },
): ToolDefinition<typeof VideoSchema, Record<string, unknown>> {
  return {
    name: "view_video",
    label: "Muse Video",
    description:
      "Parse a local video file with Muse Spark via opencode-go responses protocol. Reads the file, sends it as input_file, returns the model's answer as text. No artifacts are saved. Audio-only input is not understood by the backend; this tool is video only.",
    promptSnippet: "Parse local videos with Muse Spark",
    promptGuidelines: [
      "Use view_video when the user asks to describe or analyze a local video file. Pass an explicit path and question; do not claim the video was watched if the tool failed.",
    ],
    parameters: VideoSchema,
    async execute(callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(VideoSchema, args))
        throw new Error("Invalid view_video arguments; use the current tool schema.");
      const { path, prompt } = args as VideoArgs;
      const abs = resolve(ctx.cwd, path);
      const st = await stat(abs).catch(() => {
        throw new Error(`Video not found: ${path}`);
      });
      if (!st.isFile()) throw new Error(`Not a file: ${path}`);
      if (st.size > MAX_VIDEO_BYTES) throw new Error(`Video exceeds the 50 MB limit: ${path}`);
      const ext = extname(abs).toLowerCase();
      const mimeType = MIME_BY_EXT[ext];
      if (!mimeType) throw new Error(`Unsupported video extension ${ext || "(none)"}: use mp4/mov/webm/m4v.`);
      const bytes = await readFile(abs, { signal });
      onUpdate?.({
        content: [{ type: "text", text: `Parsing video with Muse Spark…` }],
        details: { status: "in_progress" },
      });
      const result = await deps.client(ctx).askWithFile(
        {
          filename: basename(abs),
          mimeType,
          base64: Buffer.from(bytes).toString("base64"),
          prompt,
          effort: (args.effort ?? "minimal") as ReasoningEffort,
          maxOutputTokens: args.max_output_tokens ?? 1024,
        },
        { signal, timeoutMs: (args.timeout_seconds ?? 120) * 1000 },
      );
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text: result.text }],
        details: { version: 1, status: "completed", requestId: result.requestId, turnId: callId },
      };
    },
  };
}
