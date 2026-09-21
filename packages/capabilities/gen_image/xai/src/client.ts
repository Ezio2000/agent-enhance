import type { RequestOptions, ResolveAuth } from "../../../../transports/xai/src/types.ts";
import { abortable } from "../../../../transports/xai/src/http.ts";
import { IMAGE_TIMEOUT, type ImageRequest, type ImageResponse } from "./types.ts";

export class ImageClient {
  constructor(
    private readonly auth: ResolveAuth,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async images(
    request: ImageRequest,
    options: RequestOptions = {},
  ): Promise<{ data: ImageResponse; requestId?: string }> {
    const timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT.defaultSeconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Grok image request timed out after ${timeoutMs / 1000}s. The server may still be processing it; no automatic retry was made.`,
          ),
        ),
      timeoutMs,
    );
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const auth = await abortable(this.auth(), signal);
      signal.throwIfAborted();
      const operation = request.image || request.images?.length ? "edits" : "generations";
      const response = await this.fetcher(new URL(`images/${operation}`, auth.baseUrl), {
        method: "POST",
        headers: { ...auth.headers, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        let detail = text;
        try {
          const body = JSON.parse(text);
          detail =
            typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? text);
        } catch {
          /* Preserve non-JSON server errors. */
        }
        const hint =
          response.status === 401
            ? " Reauthenticate xAI in the current host to refresh credentials."
            : response.status === 429 && /0\s*\/\s*0/.test(detail)
              ? " This token currently has a zero model rate limit; it does not prove your SuperGrok weekly allowance is exhausted. Check subscription recognition and refresh xAI login in the current host."
              : "";
        throw new Error(`Grok image API HTTP ${response.status}: ${String(detail).slice(0, 1500)}${hint}`);
      }
      const data = JSON.parse(text) as ImageResponse;
      if (
        !Array.isArray(data.data) ||
        data.data.length !== 1 ||
        typeof data.data[0]?.b64_json !== "string" ||
        !data.data[0].b64_json
      ) {
        throw new Error("Grok returned no valid single-image base64 result. No image was saved.");
      }
      return { data, requestId: response.headers.get("x-request-id") ?? undefined };
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
