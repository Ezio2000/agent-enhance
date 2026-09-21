import { stat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Value } from "typebox/value";
import type { ExecutionContext, ToolDefinition } from "../../../../core/src/contracts.ts";
import { resolveOpencodeGoAuth } from "../../../../transports/opencode/src/auth.ts";
import { ResponsesClient, type ReasoningEffort } from "../../../../transports/opencode/src/responses.ts";
import { PdfSchema, type PdfArgs } from "./schema.ts";

const MAX_PDF_BYTES = 20 * 1024 * 1024;

export function pdfTool(
  deps: { client(ctx: ExecutionContext): ResponsesClient } = {
    client: (ctx) => new ResponsesClient(() => resolveOpencodeGoAuth(ctx)),
  },
): ToolDefinition<typeof PdfSchema, Record<string, unknown>> {
  return {
    name: "view_pdf",
    label: "Muse PDF",
    description:
      "Parse a local PDF with Muse Spark via opencode-go responses protocol. Reads the file, sends it as input_file, returns the model's answer as text. No artifacts are saved. Audio is not supported by the backend and is rejected; this tool is PDF only.",
    promptSnippet: "Parse local PDFs with Muse Spark",
    promptGuidelines: [
      "Use view_pdf when the user asks to read or extract from a local PDF. Pass an explicit path and question; do not claim the PDF was read if the tool failed.",
    ],
    parameters: PdfSchema,
    async execute(callId, args, signal, onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!Value.Check(PdfSchema, args))
        throw new Error("Invalid view_pdf arguments; use the current tool schema.");
      const { path, prompt } = args as PdfArgs;
      const abs = resolve(ctx.cwd, path);
      const st = await stat(abs).catch(() => {
        throw new Error(`PDF not found: ${path}`);
      });
      if (!st.isFile()) throw new Error(`Not a file: ${path}`);
      if (st.size > MAX_PDF_BYTES) throw new Error(`PDF exceeds the 20 MB limit: ${path}`);
      if (!/\.pdf$/i.test(abs)) throw new Error(`Not a .pdf file: ${path}`);
      const bytes = await readFile(abs, { signal });
      onUpdate?.({
        content: [{ type: "text", text: `Parsing PDF with Muse Spark…` }],
        details: { status: "in_progress" },
      });
      const result = await deps.client(ctx).askWithFile(
        {
          filename: basename(abs),
          mimeType: "application/pdf",
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
