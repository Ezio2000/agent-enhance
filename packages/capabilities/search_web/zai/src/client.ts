import { HTTPTransport, ProtocolError, isRecord } from "../../../../transports/zai/src/http.ts";
import { ZaiMcpToolClient } from "../../../../transports/zai/src/mcp.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/zai/src/types.ts";
import type {
  WebReaderRequest,
  WebReaderResponse,
  WebSearchRequest,
  WebSearchResult,
  WebSearchResponse,
} from "./types.ts";

/**
 * Billing split, both live-verified with a plan key: /web_search via REST bills to the
 * pay-as-you-go balance (1113 without one) while its MCP endpoint bills to the plan's
 * monthly tool quota; /reader REST bills to the plan quota directly. So search rides
 * the subscription MCP route and the reader stays on plain REST.
 */
const SEARCH_MCP_PATH = "api/mcp/web_search_prime/mcp";
export class ZaiWebClient {
  private readonly http: HTTPTransport;
  private readonly mcp: ZaiMcpToolClient;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
    this.mcp = new ZaiMcpToolClient(resolveAuth, fetchImpl);
  }

  async webSearch(request: WebSearchRequest, options: RequestOptions = {}) {
    const text = await this.mcp.call(
      SEARCH_MCP_PATH,
      "web_search_prime",
      {
        search_query: request.search_query,
        search_engine: request.search_engine,
        search_domain_filter: request.search_domain_filter,
        search_recency_filter: request.search_recency_filter,
        content_size: request.content_size,
      },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 30000 },
    );
    // The tool payload is a JSON string inside the text content — observed double- or
    // triple-encoded depending on the service; unwrap until the result array appears.
    let results: unknown = text;
    for (let depth = 0; depth < 3 && typeof results === "string"; depth++) {
      try {
        results = JSON.parse(results);
      } catch {
        throw new ProtocolError("Zai search returned a malformed result payload.");
      }
    }
    if (!Array.isArray(results)) throw new ProtocolError("Zai search result payload is not an array.");
    const data: WebSearchResponse = { search_result: results as WebSearchResult[] };
    return { data, requestId: undefined };
  }

  async readUrl(request: WebReaderRequest, options: RequestOptions = {}) {
    const { data, requestId } = await this.http.post<WebReaderResponse>("reader", request, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 60000,
    });
    if (!isRecord(data) || data.reader_result == null)
      throw new ProtocolError("Zai response is missing reader_result.");
    const reader = data as WebReaderResponse;
    return { data: reader, requestId: (requestId ?? reader.request_id) as string | undefined };
  }
}
