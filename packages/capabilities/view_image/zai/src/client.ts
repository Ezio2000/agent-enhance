import { HTTPTransport, ProtocolError, isRecord } from "../../../../transports/zai/src/http.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/zai/src/types.ts";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "video_url"; video_url: { url: string } };
export interface VisionMessage {
  role: "system" | "user";
  content: string | ContentPart[];
}
export interface VisionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
}
export interface VisionRequest {
  model: string;
  messages: VisionMessage[];
  thinking: { type: "enabled" | "disabled" };
  max_tokens: number;
  stream: false;
}
export interface VisionResponse {
  id?: string;
  model?: string;
  request_id?: string;
  choices?: {
    finish_reason?: string;
    message?: { content?: string; reasoning_content?: string };
  }[];
  usage?: VisionUsage;
}

/**
 * GLM multimodal chat completions on the coding endpoint — the same wire shape the official
 * @z_ai/mcp-server vision MCP uses internally (verified by live probe with a plan key).
 */
export class VisionClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  async analyze(request: VisionRequest, options: RequestOptions = {}) {
    const { data, requestId } = await this.http.post<VisionResponse>("chat/completions", request, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 180000,
    });
    if (!isRecord(data) || !Array.isArray(data.choices) || !data.choices[0]?.message)
      throw new ProtocolError("Zai vision response is missing choices.");
    const message = data.choices[0].message as { content?: string };
    if (typeof message.content !== "string" || !message.content.trim())
      throw new ProtocolError(
        "Zai vision returned an empty answer; increase max_tokens or disable thinking.",
      );
    return {
      content: message.content,
      finishReason: data.choices[0].finish_reason,
      model: data.model ?? request.model,
      usage: (data.usage ?? {}) as VisionUsage,
      requestId: requestId ?? data.request_id,
    };
  }
}
