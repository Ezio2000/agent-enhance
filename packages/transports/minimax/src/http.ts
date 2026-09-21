import type { ProtocolAuth, ResolveAuth } from "./types.ts";

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(secret, "[REDACTED]");
  }
  return out
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
    .replace(/sk-cp-[A-Za-z0-9_-]+/g, "sk-cp-[REDACTED]");
}

function credentialSecrets(auth?: ProtocolAuth): string[] {
  return Object.entries(auth?.headers ?? {})
    .filter(([key]) => /authorization|token|secret|api[-_]key/i.test(key))
    .map(([, value]) => value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Nested OpenAI-style errors (/v2) and anything the gateway wraps into .error. */
export function responseError(
  value: unknown,
  status: number,
  requestId?: string,
  secrets: string[] = [],
): ProtocolError {
  const root = isRecord(value) ? value : {};
  const error = isRecord(root.error) ? root.error : root;
  const type = typeof error.type === "string" ? error.type.slice(0, 60) : undefined;
  const detail =
    typeof error.message === "string"
      ? error.message
      : typeof root.error === "string"
        ? root.error
        : "Request rejected by the backend";
  const hint =
    status === 401
      ? " Reauthenticate MiniMax in the current host."
      : status === 402
        ? " Account balance insufficient; top up MiniMax credits."
        : status === 429
          ? " Rate limited; no automatic retry was made."
          : status === 400 || status === 422
            ? " Check parameters and reference IDs."
            : "";
  return new ProtocolError(
    `MiniMax HTTP ${status}${type ? ` (${type})` : ""}: ${redact(detail, secrets).slice(0, 1200)}.${hint}${requestId ? ` Request ID: ${requestId}` : ""}`,
    status,
    type,
    requestId,
  );
}

/**
 * MiniMax returns HTTP 200 with a business status inside base_resp.status_code.
 * 0 = success; 2013 = invalid params; 2067 = plan tier/quota. Verified by live probe:
 * an unknown task_id yields 200 + 2013, and a plan without video yields 200/400 + 2067.
 */
export function businessError(
  payload: unknown,
  requestId?: string,
  secrets: string[] = [],
): ProtocolError | undefined {
  if (!isRecord(payload)) return undefined;
  const base = isRecord(payload.base_resp) ? payload.base_resp : undefined;
  const raw = base && typeof base.status_code === "number" ? base.status_code : 0;
  if (raw === 0) return undefined;
  const message =
    base && typeof base.status_msg === "string" && base.status_msg
      ? base.status_msg
      : "MiniMax reported a business error";
  const hint =
    raw === 2067
      ? " The Token Plan tier does not include this capability or its quota is exhausted; upgrade the plan or switch to credits."
      : raw === 2013
        ? " Check parameters and reference IDs."
        : "";
  return new ProtocolError(
    `MiniMax base_resp ${raw}: ${redact(message, secrets).slice(0, 1200)}.${hint}${requestId ? ` Request ID: ${requestId}` : ""}`,
    200,
    String(raw),
    requestId,
  );
}

// Minimal POST/GET transport. No SSE: media and quota endpoints return single JSON documents.
export class HTTPTransport {
  constructor(
    private readonly resolveAuth: ResolveAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async post<T>(
    path: string,
    body: unknown,
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      headers?: Record<string, string>;
      consume: (
        response: Response,
        signal: AbortSignal,
        requestId: string | undefined,
        secrets: string[],
      ) => Promise<T>;
    },
  ): Promise<{ data: T; requestId?: string }> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      options.timeoutMs,
    );
    const signal = controller.signal;
    let auth: ProtocolAuth | undefined;
    try {
      signal.throwIfAborted();
      auth = await this.resolveAuth();
      signal.throwIfAborted();
      const url = new URL(path, auth.baseUrl.replace(/\/?$/, "/"));
      const headers = new Headers(auth.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json");
      for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      return await this.finish(response, options.consume, signal, auth);
    } catch (error) {
      throw this.wrap(error, signal, auth);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  /** Quota endpoint is GET only; the documented POST example returns 404. */
  async get<T>(
    path: string,
    options: {
      signal?: AbortSignal;
      timeoutMs: number;
      consume: (
        response: Response,
        signal: AbortSignal,
        requestId: string | undefined,
        secrets: string[],
      ) => Promise<T>;
    },
  ): Promise<{ data: T; requestId?: string }> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      options.timeoutMs,
    );
    const signal = controller.signal;
    let auth: ProtocolAuth | undefined;
    try {
      signal.throwIfAborted();
      auth = await this.resolveAuth();
      signal.throwIfAborted();
      const url = new URL(path, auth.baseUrl.replace(/\/?$/, "/"));
      const headers = new Headers(auth.headers);
      headers.set("Accept", "application/json");
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal,
        redirect: "error",
      });
      return await this.finish(response, options.consume, signal, auth);
    } catch (error) {
      throw this.wrap(error, signal, auth);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async finish<T>(
    response: Response,
    consume: (
      response: Response,
      signal: AbortSignal,
      requestId: string | undefined,
      secrets: string[],
    ) => Promise<T>,
    signal: AbortSignal,
    auth: ProtocolAuth,
  ): Promise<{ data: T; requestId?: string }> {
    const secrets = credentialSecrets(auth);
    const rawId = response.headers.get("minimax-request-id") ?? response.headers.get("x-request-id");
    const requestId = rawId ? redact(rawId, secrets).slice(0, 200) : undefined;
    if (!response.ok) {
      let payload: unknown = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      signal.throwIfAborted();
      throw responseError(payload, response.status, requestId, secrets);
    }
    const data = await consume(response, signal, requestId, secrets);
    return { data, requestId };
  }

  private wrap(error: unknown, signal: AbortSignal, auth?: ProtocolAuth): Error {
    if (signal.aborted)
      return new ProtocolError(
        signal.reason instanceof Error && /timed?/i.test(signal.reason.message)
          ? "Operation timed out; it was not retried."
          : "Operation cancelled; it was not retried.",
      );
    if (error instanceof ProtocolError) return error;
    return new ProtocolError(
      `MiniMax request failed: ${redact(error instanceof Error ? error.message : String(error), credentialSecrets(auth)).slice(0, 800)}`,
    );
  }
}
