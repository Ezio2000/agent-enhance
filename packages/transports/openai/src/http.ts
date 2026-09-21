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
  const expanded = secrets.flatMap((secret) =>
    /^Bearer\s+/i.test(secret) ? [secret, secret.replace(/^Bearer\s+/i, "")] : [secret],
  );
  for (const secret of expanded.filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/Bearer\s+[^\s"\\]+/gi, "Bearer [REDACTED]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED JWT]")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function credentialSecrets(auth?: ProtocolAuth): string[] {
  return Object.entries(auth?.headers ?? {})
    .filter(([key]) => /authorization|cookie|token|secret|api[-_]key|account[-_]id/i.test(key))
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
  const hint =
    status === 401
      ? " Log in again with /login openai-codex."
      : status === 403
        ? " This account may not have access to this capability."
        : status === 429
          ? " Quota or rate limit reached; no automatic retry was made."
          : status === 400 || status === 422
            ? " Check parameters; public API fields may not be enabled on the Codex endpoint."
            : "";
  return new ProtocolError(
    `OpenAI HTTP ${status}${code ? ` (${code})` : ""}: ${redact(detail, secrets).slice(0, 1200)}.${hint}${requestId ? ` Request ID: ${requestId}` : ""}`,
    status,
    code,
    requestId,
  );
}

export async function* boundedChunks(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ProtocolError(`Response exceeds the ${maxBytes} byte safety limit.`);
  }
  if (!response.body) throw new ProtocolError("Backend returned an empty response body.");
  const reader = response.body.getReader();
  let total = 0;
  let complete = false;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) {
        complete = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) throw new ProtocolError(`Response exceeds the ${maxBytes} byte safety limit.`);
      yield value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJSON(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of boundedChunks(response, maxBytes, signal)) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProtocolError("Backend returned invalid JSON (possibly an HTML login/proxy page).");
  }
}

// Streaming parser handles UTF-8 boundaries, CRLF, comments, multiline data and a missing final newline.
export async function* readSSE(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: unknown }> {
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let event: string | undefined;
  function dispatch(): { event?: string; data: unknown } | undefined {
    const raw = data.join("\n");
    const name = event;
    data = [];
    event = undefined;
    if (!raw || raw === "[DONE]") return;
    try {
      return { event: name, data: JSON.parse(raw) };
    } catch {
      throw new ProtocolError("Backend returned malformed SSE JSON.");
    }
  }
  function line(raw: string) {
    const value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (value === "") return dispatch();
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
    if (value.startsWith("event:")) event = value.slice(6).trim();
  }
  for await (const chunk of boundedChunks(response, maxBytes, signal)) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const item = line(pending.slice(0, end));
      pending = pending.slice(end + 1);
      if (item) yield item;
    }
  }
  pending += decoder.decode();
  if (pending) {
    const item = line(pending);
    if (item) yield item;
  }
  const final = dispatch();
  if (final) yield final;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

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
      // Auth is resolved per request. the host owns token refresh/locking, not this protocol client.
      auth = await abortable(this.resolveAuth(), signal);
      signal.throwIfAborted();
      const url = new URL(path, auth.baseUrl.replace(/\/?$/, "/"));
      const headers = new Headers(auth.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json, text/event-stream");
      for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const secrets = credentialSecrets(auth);
      const rawId =
        response.headers.get("x-codex-imagegen-request-id") ?? response.headers.get("x-request-id");
      const requestId = rawId ? redact(rawId, secrets).slice(0, 200) : undefined;
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await readJSON(response, 64 * 1024, signal);
        } catch {
          payload = {};
        }
        signal.throwIfAborted();
        throw responseError(payload, response.status, requestId, secrets);
      }
      const data = await options.consume(response, signal, requestId, secrets);
      return { data, requestId };
    } catch (error) {
      if (options.signal?.aborted)
        throw new ProtocolError(
          "Operation cancelled. A remote image job may still finish; it was not retried.",
        );
      if (signal.aborted)
        throw new ProtocolError(
          "Operation timed out. A remote image job may still finish; it was not retried.",
        );
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        `OpenAI request failed: ${redact(error instanceof Error ? error.message : String(error), credentialSecrets(auth)).slice(0, 1200)}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
