import {
  HTTPTransport,
  ProtocolError,
  isRecord,
  readJSON,
  readSSE,
  responseError,
} from "../../../../transports/openai/src/http.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/openai/src/types.ts";
import {
  IMAGE_DEFAULTS,
  IMAGE_TIMEOUT,
  type ImageProgress,
  type ImageRequest,
  type ImageResponse,
  type QuotaInfo,
} from "./types.ts";
import { validateImageRequest } from "./validation.ts";

// Codex rate-limit headers arrive with the response start, long before generation finishes.
function parseQuotaHeaders(headers: Headers): QuotaInfo | undefined {
  if (headers.get("x-codex-primary-used-percent") === null) return undefined;
  const usedPercent = Number(headers.get("x-codex-primary-used-percent"));
  const resetAfter = Number(headers.get("x-codex-primary-reset-after-seconds"));
  const plan = headers.get("x-codex-plan-type");
  return {
    ...(plan ? { plan } : {}),
    ...(Number.isFinite(usedPercent) ? { usedPercent } : {}),
    ...(Number.isFinite(resetAfter) && resetAfter > 0 ? { resetAt: Date.now() + resetAfter * 1000 } : {}),
  };
}

export class ImageClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  async images(
    request: ImageRequest,
    options: RequestOptions & { turnId?: string; onProgress?: ImageProgress } = {},
  ) {
    validateImageRequest(request);
    request = {
      ...request,
      ...IMAGE_DEFAULTS,
      model: request.model ?? IMAGE_DEFAULTS.model,
      size: request.size ?? "auto",
      background: request.background ?? "auto",
      quality: request.quality ?? IMAGE_DEFAULTS.quality,
      moderation: request.moderation ?? IMAGE_DEFAULTS.moderation,
    };
    let quota: QuotaInfo | undefined;
    const result = await this.http.post<ImageResponse>(
      request.images ? "images/edits" : "images/generations",
      request,
      {
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? IMAGE_TIMEOUT.defaultSeconds * 1000,
        headers: options.turnId ? { "x-codex-image-turn-id": options.turnId } : undefined,
        consume: async (response, signal, id, secrets) => {
          quota = parseQuotaHeaders(response.headers);
          if (quota) options.onProgress?.({ quota });
          if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
            const data = await readJSON(response, 128 * 1024 * 1024, signal);
            if (isRecord(data) && data.error) throw responseError(data, 200, id, secrets);
            const result = validateImageResponse(data);
            if (request.stream)
              result.warnings = [
                "Requested SSE streaming, but the backend returned a non-streaming JSON response.",
              ];
            return result;
          }
          let completed: ImageResponse | undefined;
          for await (const item of readSSE(response, 192 * 1024 * 1024, signal)) {
            if (!isRecord(item.data)) throw new ProtocolError("Invalid image stream event.");
            const event = item.data;
            const type = typeof event.type === "string" ? event.type : (item.event ?? "");
            if (type === "error" || type.endsWith(".failed") || event.error)
              throw responseError(event, 200, id, secrets);
            if (type === "image_generation.partial_image" || type === "image_edit.partial_image") {
              options.onProgress?.({
                index: typeof event.partial_image_index === "number" ? event.partial_image_index : undefined,
                b64_json: typeof event.b64_json === "string" ? event.b64_json : undefined,
                output_format: typeof event.output_format === "string" ? event.output_format : undefined,
              });
            } else if (type === "image_generation.completed" || type === "image_edit.completed") {
              if (completed) throw new ProtocolError("Unexpected duplicate completed image stream event.");
              completed = validateImageResponse({ ...event, data: [{ b64_json: event.b64_json }] });
            }
          }
          if (!completed)
            throw new ProtocolError(
              "Image stream ended without a completed image; no partial output was treated as success.",
            );
          return completed;
        },
      },
    );
    return { ...result, quota };
  }
}

function validateImageResponse(data: unknown): ImageResponse {
  if (!isRecord(data) || !Array.isArray(data.data) || data.data.length === 0 || data.data.length > 10)
    throw new ProtocolError("Image response must contain 1–10 images.");
  for (const item of data.data) {
    if (!isRecord(item) || typeof item.b64_json !== "string" || !item.b64_json)
      throw new ProtocolError(
        "Image response is missing b64_json; remote output URL fetching is deliberately disabled.",
      );
  }
  return data as unknown as ImageResponse;
}
