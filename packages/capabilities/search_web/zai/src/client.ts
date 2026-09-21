import { HTTPTransport, ProtocolError, isRecord } from "../../../../transports/zai/src/http.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/zai/src/types.ts";
import type { WebReaderRequest, WebReaderResponse, WebSearchRequest, WebSearchResponse } from "./types.ts";
/**
 * Thin client over the GLM Coding Plan tool endpoints (both live-verified with a plan key):
 * POST /web_search (per-call billing, shared subscription quota) and POST /reader.
 */
export class ZaiWebClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  private expect(body: unknown, field: string): void {
    if (!isRecord(body) || body[field] == null) throw new ProtocolError(`Zai response is missing ${field}.`);
  }

  async webSearch(request: WebSearchRequest, options: RequestOptions = {}) {
    const { data, requestId } = await this.http.post<WebSearchResponse>("web_search", request, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30000,
    });
    this.expect(data, "search_result");
    if (!Array.isArray((data as WebSearchResponse).search_result))
      throw new ProtocolError("Zai search_result must be an array.");
    return { data: data as WebSearchResponse, requestId: requestId ?? data.request_id };
  }

  async readUrl(request: WebReaderRequest, options: RequestOptions = {}) {
    const { data, requestId } = await this.http.post<WebReaderResponse>("reader", request, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 60000,
    });
    this.expect(data, "reader_result");
    return { data: data as WebReaderResponse, requestId: requestId ?? data.request_id };
  }
}
