import type { ExecutionContext } from "../../../packages/core/src/contracts.ts";
import { WebClient } from "../../../packages/capabilities/search_web/openai/src/client.ts";
import { ImageClient } from "../../../packages/capabilities/gen_image/openai/src/client.ts";
import type { SearchRequest } from "../../../packages/capabilities/search_web/openai/src/types.ts";
import type { ImageRequest } from "../../../packages/capabilities/gen_image/openai/src/types.ts";

export const auth = async () => ({
  baseUrl: "https://chatgpt.com/backend-api/codex/",
  headers: { Authorization: "Bearer test-secret", "chatgpt-account-id": "test-account" },
});
export const search: SearchRequest = {
  id: "session",
  model: "gpt-6-astra",
  commands: { search_query: [{ q: "OpenAI docs" }] },
};
export const image: ImageRequest = { model: "gpt-image-2", prompt: "A small blue square" };
export const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
export const ctx = (cwd: string, messages: unknown[] = []) =>
  ({
    cwd,
    model: { provider: "openai-codex", id: "gpt-6-astra" },
    sessionId: "session",
    host: "test",
    history: messages,
  }) as unknown as ExecutionContext;

type Capture = (path: string, body: Record<string, any>) => unknown;
const mockAuth = async () => ({
  baseUrl: "https://chatgpt.com/backend-api/codex/",
  headers: { Authorization: "Bearer mock" },
});
const captureFetch =
  (capture: Capture): typeof fetch =>
  async (url, init) =>
    json(capture(String(url), JSON.parse(String(init?.body))));
export const fakeWebClient = (capture: Capture) => new WebClient(mockAuth, captureFetch(capture));
export const fakeImageClient = (capture: Capture) => new ImageClient(mockAuth, captureFetch(capture));
