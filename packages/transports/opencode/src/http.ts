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
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED JWT]");
}

function credentialSecrets(auth?: ProtocolAuth): string[] {
  return Object.entries(auth?.headers ?? {})
    .filter(([key]) => /authorization|token|secret|api[-_]key/i.test(key))
    .map(([, value]) => value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function responseError(
  value: unknown,
  status: number,
  requestId?: string,
  secrets: string[] = [],
): ProtocolError {
  const root = isRecord(value) ? value : {};
  const error = isRecord(root.error) ? root.error : root;
  const code = typeof error.code === "string" ? redact(error.code, secrets).slice(0, 100) : undefined;
  const detail =
    typeof error.message === "string"
      ? error.message
      : typeof root.error === "string"
        ? root.error
        : "Request rejected by the backend";
  return new ProtocolError(
    `opencode-go HTTP ${status}${code ? ` (${code})` : ""}: ${redact(detail, secrets).slice(0, 1200)}.${requestId ? ` Request ID: ${requestId}` : ""}`,
    status,
    code,
    requestId,
  );
}

// Minimal POST transport modeled on openai-codex-enhance/src/shared/http.ts,
// without SSE: responses protocol returns a single JSON document.
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
      const secrets = credentialSecrets(auth);
      const rawId = response.headers.get("x-request-id");
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
      const data = await options.consume(response, signal, requestId, secrets);
      return { data, requestId };
    } catch (error) {
      if (options.signal?.aborted) throw new ProtocolError("Operation cancelled; it was not retried.");
      if (signal.aborted) throw new ProtocolError("Operation timed out; it was not retried.");
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        `opencode-go request failed: ${redact(error instanceof Error ? error.message : String(error), credentialSecrets(auth)).slice(0, 800)}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
