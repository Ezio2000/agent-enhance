import test from "node:test";
import assert from "node:assert/strict";
import { ImageClient } from "../../../../packages/capabilities/gen_image/minimax/src/client.ts";
import { png as PNG } from "./fixture.ts";

const auth = async () => ({
  baseUrl: "https://api.minimaxi.com/v1/",
  headers: { Authorization: "Bearer sk-cp-test" },
});
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("generation posts fixed defaults and decodes data.image_base64", async () => {
  let calls = 0;
  const client = new ImageClient(auth, async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.minimaxi.com/v1/image_generation");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "image-01",
      prompt: "blue circle",
      n: 1,
      response_format: "base64",
      aspect_ratio: "16:9",
      seed: 42,
    });
    return json({ data: { image_base64: [PNG().toString("base64")] }, base_resp: { status_code: 0 } }, 200, {
      "minimax-request-id": "req-1",
    });
  });
  const result = await client.images({
    model: "image-01",
    prompt: "blue circle",
    n: 1,
    response_format: "base64",
    aspect_ratio: "16:9",
    seed: 42,
  });
  assert.equal(result.data.imageBase64.length, 1);
  assert.equal(result.requestId, "req-1");
  assert.equal(calls, 1);
});

test("HTTP 200 with base_resp 2067 surfaces the tier limit, not a silent success", async () => {
  const client = new ImageClient(auth, async () =>
    json({
      task_id: "",
      base_resp: { status_code: 2067, status_msg: "当前已达到 Token Plan 用量上限。请升级或购买积分。" },
    }),
  );
  await assert.rejects(
    client.images({ model: "image-01", prompt: "x", n: 1, response_format: "base64" }),
    (error: Error) => {
      assert.match(error.message, /2067/);
      assert.match(error.message, /Token Plan tier does not include/);
      assert.match(error.message, /Token Plan 用量上限/);
      return true;
    },
  );
});

test("base_resp 2013 invalid params and missing image_base64 are failures; no retry", async () => {
  let calls = 0;
  const client = new ImageClient(auth, async () => {
    calls++;
    return json({ data: {}, base_resp: { status_code: 0, status_msg: "success" } });
  });
  await assert.rejects(
    client.images({ model: "image-01", prompt: "x", n: 1, response_format: "base64" }),
    /missing data\.image_base64/,
  );
  assert.equal(calls, 1);
});

test("nested v2-style HTTP errors and timeouts are wrapped; secrets are redacted", async () => {
  const client = new ImageClient(
    auth,
    async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "bad_request_error", message: "Bearer sk-cp-test leaked" },
          request_id: "r9",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(
    client.images({ model: "image-01", prompt: "x", n: 1, response_format: "base64" }),
    (error: Error) => {
      assert.match(error.message, /MiniMax HTTP 400 \(bad_request_error\)/);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /sk-cp-test/);
      return true;
    },
  );
  const slow = new ImageClient(
    auth,
    (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
      ),
  );
  await assert.rejects(
    slow.images({ model: "image-01", prompt: "x", n: 1, response_format: "base64" }, { timeoutMs: 10 }),
    /timed out/,
  );
});
