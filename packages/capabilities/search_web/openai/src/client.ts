import {
  HTTPTransport,
  ProtocolError,
  isRecord,
  readJSON,
  responseError,
} from "../../../../transports/openai/src/http.ts";
import type { ResolveAuth, RequestOptions } from "../../../../transports/openai/src/types.ts";
import type { SearchRequest, SearchResponse } from "./types.ts";
import { validateSearchRequest } from "./validation.ts";

export class WebClient {
  private readonly http: HTTPTransport;
  constructor(resolveAuth: ResolveAuth, fetchImpl: typeof fetch = fetch) {
    this.http = new HTTPTransport(resolveAuth, fetchImpl);
  }

  async search(request: SearchRequest, options: RequestOptions = {}) {
    validateSearchRequest(request);
    return this.http.post<SearchResponse>("alpha/search", request, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 90000,
      consume: async (response, signal, id, secrets) => {
        const data = await readJSON(response, 8 * 1024 * 1024, signal);
        if (isRecord(data) && data.error) throw responseError(data, 200, id, secrets);
        if (!isRecord(data) || typeof data.output !== "string")
          throw new ProtocolError("Search response is missing output.");
        if (data.results != null && !Array.isArray(data.results))
          throw new ProtocolError("Search results must be an array.");
        return data as unknown as SearchResponse;
      },
    });
  }
}
