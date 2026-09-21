import test from "node:test";
import assert from "node:assert/strict";
import { ImageClient } from "../../../../packages/capabilities/gen_image/xai/src/client.ts";
import { IMAGE_DEFAULTS } from "../../../../packages/capabilities/gen_image/xai/src/types.ts";

const auth = async () => ({ baseUrl: "https://api.x.ai/v1/", headers: { Authorization: "Bearer token" } });
const request = { ...IMAGE_DEFAULTS, prompt: "blue square" };

test("zero rate limit explains token recognition without asserting exhausted subscription; no retry", async () => {
  let calls = 0;
  const client = new ImageClient(auth, async () => {
    calls++;
    return Response.json({ error: "Requests per Minute (actual/limit): 0/0" }, { status: 429 });
  });
  await assert.rejects(client.images(request), /does not prove.*weekly allowance is exhausted/);
  assert.equal(calls, 1);
});

test("401/403/server errors retain status and do not retry", async () => {
  for (const status of [401, 403, 500]) {
    let calls = 0;
    const client = new ImageClient(auth, async () => {
      calls++;
      return Response.json({ error: { message: "backend reason" } }, { status });
    });
    await assert.rejects(client.images(request), new RegExp(`HTTP ${status}: backend reason`));
    assert.equal(calls, 1);
  }
});

test("empty/URL-only/unexpected batch results are not reported as generated images", async () => {
  for (const data of [
    [],
    [{ url: "https://example.com/image.jpg" }],
    [{ b64_json: "a" }, { b64_json: "b" }],
  ]) {
    await assert.rejects(
      new ImageClient(auth, async () => Response.json({ data })).images(request),
      /No image was saved/,
    );
  }
});

test("cancellation is propagated and an already-cancelled call never resolves auth", async () => {
  const controller = new AbortController();
  controller.abort(new Error("user cancelled"));
  const client = new ImageClient(async () => {
    throw new Error("unexpected auth");
  });
  await assert.rejects(client.images(request, { signal: controller.signal }), /user cancelled/);
});

test("timeout aborts the in-flight request without retrying", async () => {
  let calls = 0;
  const client = new ImageClient(auth, async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }),
    );
  });
  await assert.rejects(client.images(request, { timeoutMs: 10 }), /timed out/);
  assert.equal(calls, 1);
});

test("timeout also bounds waiting for a stuck OAuth refresh", async () => {
  const client = new ImageClient(() => new Promise(() => {}));
  await assert.rejects(client.images(request, { timeoutMs: 10 }), /timed out/);
});
