import test from "node:test";
import assert from "node:assert/strict";
import { ProtocolError, readJSON, readSSE } from "../../../packages/transports/openai/src/http.ts";
import { ImageClient } from "../../../packages/capabilities/gen_image/openai/src/client.ts";
import { WebClient } from "../../../packages/capabilities/search_web/openai/src/client.ts";
import { auth, image, search, json } from "../../fixtures/openai/helpers.ts";

test("authentication and quota errors preserve codes but redact credentials; no retries", async () => {
  for (const status of [400, 401, 403, 429, 500]) {
    let calls = 0;
    const client = new ImageClient(auth, async () => {
      calls++;
      return json(
        { error: { code: "unsupported_parameter", message: "test-secret test-account Bearer leaked-value" } },
        status,
      );
    });
    await assert.rejects(client.images(image), (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.status, status);
      assert.equal(error.code, "unsupported_parameter");
      assert.doesNotMatch(error.message, /test-secret|test-account|leaked-value/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("SSE handles one-byte chunks, UTF-8, comments, multiline data and EOF", async () => {
  const bytes = new TextEncoder().encode(
    ': comment\r\nevent: demo\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: {"last":true}',
  );
  let i = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (i === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(i, ++i));
      },
    }),
  );
  const events = [];
  for await (const event of readSSE(response, 1000)) events.push(event);
  assert.deepEqual(events, [
    { event: "demo", data: { text: "你好" } },
    { event: undefined, data: { last: true } },
  ]);
});

test("bounded JSON rejects declared and actual oversized payloads", async () => {
  await assert.rejects(readJSON(new Response("{}", { headers: { "content-length": "999" } }), 10), /limit/);
  await assert.rejects(readJSON(new Response('"abcdefghijk"'), 10), /limit/);
});

test("abort and timeout terminate HTTP without retry", async () => {
  const blockedFetch: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  const client = new WebClient(auth, blockedFetch);
  await assert.rejects(client.search(search, { timeoutMs: 10 }), /timed out/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.search(search, { signal: controller.signal }), /cancelled/);
  let bodyCancelled = false;
  const body = new ReadableStream({
    cancel() {
      bodyCancelled = true;
    },
  });
  await assert.rejects(
    new WebClient(auth, async () => new Response(body)).search(search, { timeoutMs: 10 }),
    /timed out/,
  );
  assert.ok(bodyCancelled);
});

test("auth resolution timeout does not hang the request or later send credentials", async () => {
  let fetches = 0;
  const client = new WebClient(
    () => new Promise(() => {}),
    async () => {
      fetches++;
      return new Response("{}");
    },
  );
  await assert.rejects(
    client.search(
      { id: "s", model: "gpt-6-astra", commands: { search_query: [{ q: "test" }] } },
      { timeoutMs: 10 },
    ),
    /timed out/,
  );
  assert.equal(fetches, 0);
});
