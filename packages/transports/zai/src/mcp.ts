import type { ProtocolAuth, ResolveAuth, RequestOptions } from "./types.ts";
import { ProtocolError, isRecord, redact, responseError } from "./http.ts";

interface McpContent {
  type: string;
  text?: string;
}
interface McpToolResult {
  content?: McpContent[];
  isError?: boolean;
}

/**
 * Minimal MCP streamable-HTTP tool caller for the subscription-billed MCP endpoints
 * (live-verified: initialize → tools/call suffices; notifications/initialized and a
 * persistent session beyond the header are not required). Responses arrive as SSE
 * frames; tool payloads are JSON strings inside content[0].text (double-encoded).
 */
export class ZaiMcpToolClient {
  private sessionId: string | undefined;
  constructor(
    private readonly resolveAuth: ResolveAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async rpc(
    auth: ProtocolAuth,
    path: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<{ json: unknown; sessionHeader: string | null }> {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      options.timeoutMs,
    );
    const signal = controller.signal;
    try {
      signal.throwIfAborted();
      // MCP routes hang off the platform origin, one level above the coding REST base.
      const mcpUrl = new URL(path, new URL(auth.baseUrl).origin + "/");
      const headers = new Headers(auth.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json, text/event-stream");
      if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
      const response = await this.fetchImpl(mcpUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const sessionHeader = response.headers.get("mcp-session-id");
      const text = await response.text();
      signal.throwIfAborted();
      if (!response.ok) {
        let payload: unknown = {};
        try {
          payload = JSON.parse(text || "{}");
        } catch {
          payload = {};
        }
        throw responseError(payload, response.status, undefined, [auth.headers.Authorization ?? ""]);
      }
      const data = parseSseJson(text, Number(body.id));
      if (data === undefined) throw new ProtocolError("MCP response contained no result frame.");
      if (isRecord(data) && "error" in data) {
        const error = isRecord((data as { error: unknown }).error)
          ? (data as { error: Record<string, unknown> }).error
          : {};
        throw new ProtocolError(
          `MCP error ${String(error.code ?? "")}: ${redact(typeof error.message === "string" ? error.message : "unknown")}`.slice(
            0,
            800,
          ),
        );
      }
      return { json: data, sessionHeader };
    } catch (error) {
      if (signal.aborted)
        throw new ProtocolError(
          signal.reason instanceof Error && /timed?/i.test(signal.reason.message)
            ? "Operation timed out; it was not retried."
            : "Operation cancelled; it was not retried.",
        );
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError(
        `MCP request failed: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 800)}`,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private async withSession(
    path: string,
    run: (auth: ProtocolAuth) => Promise<unknown>,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<unknown> {
    const auth = await this.resolveAuth();
    if (!this.sessionId) await this.establish(path, auth, options);
    try {
      return await run(auth);
    } catch (error) {
      // Sessions expire server-side; re-establish exactly once. Only session-level failures
      // (HTTP 404 or MCP -401, meaning the call never executed) are retried — never a
      // completed tool call — so no side effect is replayed.
      if (error instanceof ProtocolError && (error.status === 404 || /MCP error -?401/.test(error.message))) {
        this.sessionId = undefined;
        await this.establish(path, auth, options);
        return await run(auth);
      }
      throw error;
    }
  }

  private async establish(
    path: string,
    auth: ProtocolAuth,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<void> {
    const init = await this.rpc(
      auth,
      path,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agent-enhance", version: "0.2.0" },
        },
      },
      options,
    );
    if (!init.sessionHeader) throw new ProtocolError("MCP endpoint did not return a session id.");
    this.sessionId = init.sessionHeader;
  }

  /** Returns the decoded text payload of the tool result. */
  async call(
    path: string,
    tool: string,
    args: Record<string, unknown>,
    options: RequestOptions & { timeoutMs: number },
  ): Promise<string> {
    const text = (await this.withSession(
      path,
      (auth) =>
        this.rpc(
          auth,
          path,
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } },
          options,
        ).then((response) => {
          const payload = (response.json as { result?: McpToolResult }).result;
          const content = payload?.content?.find((part) => part.type === "text")?.text;
          if (payload?.isError || content === undefined)
            throw new ProtocolError(
              `MCP tool ${tool} failed: ${redact(String(content ?? "no text payload"))}`.slice(0, 800),
            );
          return content as string;
        }),
      options,
    )) as string;
    return text;
  }
}

/** Parses `event:/data:` SSE frames and returns the JSON payload matching the request id. */
export function parseSseJson(text: string, id: number): unknown {
  let parsed: unknown;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      parsed = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
  }
  return isRecord(parsed) && parsed.id === id ? parsed : parsed;
}
