import type { RequestOptions, ResolveAuth } from "../../../../transports/xai/src/types.ts";
import { abortable } from "../../../../transports/xai/src/http.ts";
import {
  VIDEO_POLL_INTERVAL_MS,
  VIDEO_TIMEOUT,
  type VideoPollResponse,
  type VideoRequest,
  type VideoStartResponse,
} from "./types.ts";

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorDetail(text: string): string {
  try {
    const body = JSON.parse(text);
    return typeof body.error === "string" ? body.error : (body.error?.message ?? body.message ?? text);
  } catch {
    return text;
  }
}

function httpError(status: number, detail: string, kind: string): Error {
  const hint =
    status === 401
      ? " Reauthenticate xAI in the current host to refresh credentials."
      : status === 429 && /0\s*\/\s*0/.test(detail)
        ? " This token currently has a zero model rate limit; it does not prove your SuperGrok weekly allowance is exhausted. Check subscription recognition and refresh xAI login in the current host."
        : "";
  return new Error(`Grok video ${kind} HTTP ${status}: ${String(detail).slice(0, 1500)}${hint}`);
}

export class VideoClient {
  constructor(
    private readonly auth: ResolveAuth,
    private readonly fetcher: typeof fetch = fetch,
    private readonly pollIntervalMs = VIDEO_POLL_INTERVAL_MS,
  ) {}

  async videos(
    request: VideoRequest,
    options: RequestOptions = {},
  ): Promise<{ bytes: Uint8Array; requestId: string }> {
    const timeoutMs = options.timeoutMs ?? VIDEO_TIMEOUT.defaultSeconds * 1000;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Grok video request timed out after ${timeoutMs / 1000}s. The server may still be processing it; no automatic retry was made.`,
          ),
        ),
      timeoutMs,
    );
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const auth = await abortable(this.auth(), signal);
      signal.throwIfAborted();
      const start = await this.fetcher(new URL("videos/generations", auth.baseUrl), {
        method: "POST",
        headers: { ...auth.headers, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
        signal,
      });
      const startText = await start.text();
      if (!start.ok) throw httpError(start.status, errorDetail(startText), "start");
      let startBody: VideoStartResponse;
      try {
        startBody = JSON.parse(startText) as VideoStartResponse;
      } catch {
        throw new Error(`Failed to parse video start response: ${startText.slice(0, 500)}`);
      }
      const requestId = startBody.request_id?.trim() ?? "";
      if (!requestId) throw new Error("Grok returned no request_id. No video was saved.");
      const pollUrl = new URL(`videos/${encodeURIComponent(requestId)}`, auth.baseUrl);
      while (true) {
        await delay(this.pollIntervalMs, signal);
        const poll = await this.fetcher(pollUrl, {
          method: "GET",
          headers: { ...auth.headers, Accept: "application/json" },
          signal,
        });
        const pollText = await poll.text();
        if (!poll.ok && poll.status !== 202) throw httpError(poll.status, errorDetail(pollText), "poll");
        let pollBody: VideoPollResponse;
        try {
          pollBody = JSON.parse(pollText) as VideoPollResponse;
        } catch {
          throw new Error(`Failed to parse video poll response: ${pollText.slice(0, 500)}`);
        }
        const status = pollBody.status ?? "";
        if (status === "done") {
          const videoUrl = pollBody.video?.url?.trim() ?? "";
          if (!videoUrl)
            throw new Error(
              `Video generation completed but no download URL was returned (request_id=${requestId}).`,
            );
          return { bytes: await this.download(videoUrl, options.signal), requestId };
        }
        if (status === "failed")
          throw new Error(
            `Video generation failed on the server (request_id=${requestId}): ${pollText.slice(0, 300)}`,
          );
        if (status === "expired")
          throw new Error(`Video generation request expired (request_id=${requestId}).`);
      }
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(VIDEO_TIMEOUT.downloadSeconds * 1000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetcher(url, { signal: combined });
    if (!response.ok) throw new Error(`Video download failed (HTTP ${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) throw new Error("Video download returned no data.");
    return bytes;
  }
}
