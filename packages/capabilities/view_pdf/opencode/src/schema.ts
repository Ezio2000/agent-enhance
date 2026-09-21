import { Type, type Static } from "typebox";
import { choices, object, text } from "../../../../transports/opencode/src/schema.ts";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const PdfSchema = object({
  path: text("Local PDF file to parse; relative to current working directory", 4096),
  prompt: text("What to extract or answer from the PDF", 4000),
  effort: Type.Optional(choices([...EFFORTS], "Reasoning effort; default minimal")),
  max_output_tokens: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, description: "Default 1024" })),
  timeout_seconds: Type.Optional(
    Type.Integer({ minimum: 10, maximum: 300, description: "Default 120. Never automatically retried." }),
  ),
});
export type PdfArgs = Static<typeof PdfSchema>;
