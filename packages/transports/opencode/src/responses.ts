import { randomUUID } from "node:crypto";
import { HTTPTransport, isRecord } from "./http.ts";
import type { ResolveAuth, RequestOptions } from "./types.ts";

export const MUSE_MODEL = "muse-spark-1.3-contributor";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

interface ResponsesOutput {
  text: string;
  requestId?: string;
}

// Single responses-protocol client shared by pdf/video.
// Verified manually: input_file + file_data data URLs work for
// application/pdf and video/mp4; input_audio returns 200 but
// does not understand audio, so audio is rejected in validation.
export class ResponsesClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  async askWithFile(
    args: {
      filename: string;
      mimeType: string;
      base64: string;
      prompt: string;
      effort?: ReasoningEffort;
      maxOutputTokens?: number;
    },
    options: RequestOptions = {},
  ): Promise<ResponsesOutput> {
    const body = {
      model: MUSE_MODEL,
      store: false,
      reasoning: { effort: args.effort ?? "minimal" },
      max_output_tokens: args.maxOutputTokens ?? 1024,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: args.prompt },
            {
              type: "input_file",
              filename: args.filename,
              file_data: `data:${args.mimeType};base64,${args.base64}`,
            },
          ],
        },
      ],
    };
    const result = await this.http.post<string>("responses", body, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 120_000,
      // Missing session header => 400 MissingSessionID on this gateway.
      headers: { "x-opencode-session": randomUUID() },
      consume: async (response, signal) => {
        signal.throwIfAborted();
        const data: unknown = await response.json();
        return extractText(data);
      },
    });
    return { text: result.data, requestId: result.requestId };
  }
}

function extractText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.output)) {
    throw new Error("Unexpected responses payload: missing output array.");
  }
  const texts: string[] = [];
  for (const item of data.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string" && part.text) {
        texts.push(part.text);
      }
    }
  }
  const text = texts.join("\n").trim();
  if (!text) throw new Error("Backend returned an empty answer; try a larger max_output_tokens.");
  return text;
}
