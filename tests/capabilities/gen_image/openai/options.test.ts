import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";
import {
  ImageSchema,
  type ImageArgs,
} from "../../../../packages/capabilities/gen_image/openai/src/schema.ts";
import { imageTool, imageWireOptions } from "../../../../packages/capabilities/gen_image/openai/src/tool.ts";
import { ImageClient } from "../../../../packages/capabilities/gen_image/openai/src/client.ts";
import { ImageArtifactStore } from "../../../../packages/capabilities/gen_image/openai/src/artifacts.ts";
import {
  IMAGE_FIXED,
  IMAGE_DEFAULTS,
  type ImageRequest,
} from "../../../../packages/capabilities/gen_image/openai/src/types.ts";

const ctx = {
  cwd: "/unused",
  model: { id: "gpt-6-astra", provider: "openai-codex" },
  sessionManager: {
    getSessionId: () => "test-session",
    buildContextEntries: () => [],
  },
} as unknown as ExecutionContext;

test("fixed image defaults cannot be overridden and removed fields fail before HTTP", async () => {
  assert.deepEqual(imageWireOptions({ prompt: "hello" }), {
    ...IMAGE_DEFAULTS,
    prompt: "hello",
    size: "auto",
    background: "auto",
  });
  let authCalls = 0;
  const client = new ImageClient(async () => {
    authCalls++;
    throw new Error("Should not resolve auth");
  });
  for (const extra of [
    { n: 2 },
    { stream: false },
    { model: "gpt-image-1.5" },
    { quality: "invalid" },
    { output_format: "webp" },
    { partial_images: 1 },
    { mask: {} },
    { images: [{ file_id: "removed" }] },
  ]) {
    await assert.rejects(
      client.images({ ...IMAGE_DEFAULTS, prompt: "hello", ...extra } as unknown as ImageRequest),
    );
  }
  const tool = imageTool({ client: () => client, artifacts: new ImageArtifactStore("/unused") });
  for (const extra of [
    { n: 1 },
    { moderation: "off" },
    { images: [{ file_id: "removed" }] },
    { mask: { path: "/never-read" } },
  ]) {
    await assert.rejects(
      tool.execute("call", { prompt: "hello", ...extra } as unknown as ImageArgs, undefined, undefined, ctx),
      /Invalid gen_image arguments/,
    );
  }
  assert.equal(authCalls, 0);
});

test("all quality values survive schema, adapter and HTTP; moderation is fixed to low for generation and edits", async () => {
  for (const quality of ["auto", "low", "medium", "high"] as const) {
    const args = { prompt: "test", quality };
    assert.ok(Value.Check(ImageSchema, args));
    for (const edit of [false, true]) {
      const request = {
        ...imageWireOptions(args),
        ...(edit ? { images: [{ image_url: "https://example.com/input.png" }] } : {}),
      };
      let calls = 0;
      const client = new ImageClient(
        async () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/", headers: {} }),
        async (url, init) => {
          calls++;
          assert.ok(String(url).endsWith(edit ? "images/edits" : "images/generations"));
          const body = JSON.parse(String(init?.body));
          assert.equal(body.quality, quality);
          assert.equal(body.moderation, "low");
          for (const [key, value] of Object.entries(IMAGE_FIXED)) assert.equal(body[key], value);
          return new Response('data: {"type":"image_generation.completed","b64_json":"aGVsbG8="}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        },
      );
      await client.images(request);
      assert.equal(calls, 1);
    }
  }
});
