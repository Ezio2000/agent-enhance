import test from "node:test";
import assert from "node:assert/strict";
import { ZaiMcpToolClient, parseSseJson } from "../../../packages/transports/zai/src/mcp.ts";

const auth = async () => ({
  baseUrl: "https://api.z.ai/api/coding/paas/v4/",
  headers: { Authorization: "Bearer test-secret-value-1234567890" },
});
const sse = (payload: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" },
  });

test("parseSseJson picks the last data frame", () => {
  const frame = 'data: {"id":1,"a":1}\n\ndata: {"id":2,"b":2}\n';
  assert.deepEqual(parseSseJson(frame, 2), { id: 2, b: 2 });
  assert.equal(parseSseJson("data: not-json\n", 1), undefined);
});

test("initialize once, reuse session, decode double-encoded tool payload", async () => {
  const calls: { url: string; body: any; session?: string | null }[] = [];
  const payload = JSON.stringify([{ title: "T", link: "https://a/1" }]);
  const client = new ZaiMcpToolClient(auth, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, session: (init?.headers as Headers).get("mcp-session-id") });
    if (body.method === "initialize") return sse({ jsonrpc: "2.0", id: 0, result: { capabilities: {} } });
    return new Response(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: payload }] },
      })}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  const first = await client.call(
    "api/mcp/web_search_prime/mcp",
    "web_search_prime",
    { search_query: "q" },
    { timeoutMs: 1000 },
  );
  const second = await client.call(
    "api/mcp/web_search_prime/mcp",
    "web_search_prime",
    { search_query: "r" },
    { timeoutMs: 1000 },
  );
  assert.equal(first, payload);
  assert.equal(second, payload);
  assert.equal(calls.length, 3); // initialize + two calls; no repeated handshake
  assert.match(calls[0]!.url, /\/api\/mcp\/web_search_prime\/mcp$/); // rewritten away from the coding REST base
  assert.equal(calls[0]!.body.method, "initialize");
  assert.equal(calls[1]!.session, "sess-1");
  assert.equal(calls[2]!.session, "sess-1");
});

test("expired session re-initializes exactly once; tool errors surface verbatim", async () => {
  let initialized = 0;
  const failing = () =>
    new Response(
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { isError: true, content: [{ type: "text", text: "MCP error -401: session gone" }] },
      })}`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  const client = new ZaiMcpToolClient(auth, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === "initialize") {
      initialized++;
      return sse({ jsonrpc: "2.0", id: 0, result: {} });
    }
    return failing();
  });
  await assert.rejects(
    client.call("api/mcp/web_search_prime/mcp", "web_search_prime", {}, { timeoutMs: 1000 }),
    /MCP tool web_search_prime failed.*session gone/,
  );
  assert.equal(initialized, 2); // initial handshake + one re-establish after the expired-session error
});
