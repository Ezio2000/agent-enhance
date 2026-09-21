import {
  HTTPTransport,
  ProtocolError,
  businessError,
  isRecord,
} from "../../../../transports/minimax/src/http.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/minimax/src/types.ts";
import { IMAGE_DEFAULTS, IMAGE_TIMEOUT, type ImageRequest, type ImageResponse } from "./types.ts";
import { validateImageRequest } from "./validation.ts";

export class ImageClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  async images(
    request: ImageRequest,
    options: RequestOptions = {},
  ): Promise<{ data: ImageResponse; requestId?: string }> {
    validateImageRequest(request);
    const body: ImageRequest = {
      ...IMAGE_DEFAULTS,
      model: request.model ?? IMAGE_DEFAULTS.model,
      prompt: request.prompt,
      ...(request.aspect_ratio === undefined ? {} : { aspect_ratio: request.aspect_ratio }),
      ...(request.prompt_optimizer === undefined ? {} : { prompt_optimizer: request.prompt_optimizer }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    };
    const result = await this.http.post<ImageResponse>("image_generation", body, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? IMAGE_TIMEOUT.defaultSeconds * 1000,
      consume: async (response, signal, requestId, secrets) => {
        const payload: unknown = await response.json();
        signal.throwIfAborted();
        const failure = businessError(payload, requestId, secrets);
        if (failure) throw failure;
        const root = isRecord(payload) ? payload : {};
        const data = isRecord(root.data) ? root.data : undefined;
        const base64 =
          data && Array.isArray(data.image_base64) ? (data.image_base64 as unknown[]) : undefined;
        if (!base64 || base64.length !== 1 || typeof base64[0] !== "string" || !base64[0])
          throw new ProtocolError(
            "MiniMax image response is missing data.image_base64; no image was generated.",
          );
        const metadata = isRecord(root.metadata) ? root.metadata : undefined;
        return {
          imageBase64: [base64[0]],
          metadata: {
            ...(typeof metadata?.success_count === "string" ? { success_count: metadata.success_count } : {}),
            ...(typeof metadata?.failed_count === "string" ? { failed_count: metadata.failed_count } : {}),
          },
        };
      },
    });
    return result;
  }
}
