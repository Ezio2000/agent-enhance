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
  return out.replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]");
}

function credentialSecrets(auth?: ProtocolAuth): string[] {
  return Object.entries(auth?.headers ?? {})
    .filter(([key]) => /authorization|token|secret|api[-_]key/i.test(key))
    .map(([, value]) => value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Observed Z.ai/Zhipu error envelopes, verified by live probes against the coding endpoint:
 * REST tools answer {"error":{"code":"1214","message":...}} (HTTP 400) or
 * {"error":{"code":"1113",...}} with HTTP 429; the shared gateway additionally wraps
 * {"code":1001|401,"msg":...,"success":false}. Both shapes are unwrapped here.
 */
export function responseError(
  value: unknown,
  status: number,
  requestId?: string,
  secrets: string[] = [],
): ProtocolError {
  const root = isRecord(value) ? value : {};
  const error = isRecord(root.error) ? root.error : root;
  const code =
    typeof error.code === "string" || typeof error.code === "number" ? String(error.code) : undefined;
  const detail =
    typeof error.message === "string"
      ? error.message
      : typeof error.msg === "string"
        ? error.msg
        : typeof root.error === "string"
          ? root.error
          : "Request rejected by the backend";
  const hint =
    status === 401 || code === "1001" || code === "401"
      ? " Reauthenticate the GLM Coding Plan in the current host."
      : code === "1113"
        ? " No subscription quota on this endpoint; confirm the key belongs to a GLM Coding Plan."
        : code === "1302" || code === "1303"
          ? " Risk-control response; stop calling and review the subscription usage rules. No retry was made."
          : status === 429
            ? " Rate limited; no automatic retry was made."
            : code === "1214"
              ? " Check parameters."
              : code === "1701"
                ? " Search concurrency limit; retry fewer parallel queries."
                : code === "1703"
                  ? " The search returned no usable results; try a different query."
                  : "";
  return new ProtocolError(
    `Zai HTTP ${status}${code ? ` (${code})` : ""}: ${redact(detail, secrets).slice(0, 1200)}.${hint}${requestId ? ` Request ID: ${requestId}` : ""}`,
    status,
    code,
    requestId,
  );
}

/** Coding-plan tool endpoints return plain JSON documents; no SSE on this path. */
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
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const secrets = credentialSecrets(auth);
      const rawId = response.headers.get("x-request-id") ?? response.headers.get("ga-traceid");
      const requestId = rawId ? redact(rawId, secrets).slice(0, 200) : undefined;
      let payload: unknown = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      signal.throwIfAborted();
      if (!response.ok) throw responseError(payload, response.status, requestId, secrets);
      return { data: payload as T, requestId };
    } catch (error) {
      if (signal.aborted)
        throw new ProtocolError(
          signal.reason instanceof Error && /timed?/i.test(signal.reason.message)
            ? "Operation timed out; it was not retried."
            : "Operation cancelled; it was not retried.",
        );
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        `Zai request failed: ${redact(error instanceof Error ? error.message : String(error), credentialSecrets(auth)).slice(0, 800)}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
