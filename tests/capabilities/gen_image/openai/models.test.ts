import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { ImageSchema } from "../../../../packages/capabilities/gen_image/openai/src/schema.ts";
import { imageWireOptions } from "../../../../packages/capabilities/gen_image/openai/src/tool.ts";
import { ImageClient } from "../../../../packages/capabilities/gen_image/openai/src/client.ts";
import { IMAGE_MODELS, IMAGE_FIXED } from "../../../../packages/capabilities/gen_image/openai/src/types.ts";

test("model selection survives schema, adapter and HTTP for generation and edits", async () => {
  for (const model of [undefined, ...IMAGE_MODELS]) {
    const args = { prompt: "test", ...(model ? { model } : {}) };
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
          assert.equal(body.model, model ?? "gpt-image-2.5-flare");
          assert.equal(body.quality, "auto");
          for (const [key, value] of Object.entries(IMAGE_FIXED)) assert.equal(body[key], value);
          return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
            headers: { "content-type": "application/json" },
          });
        },
      );
      await client.images(request);
      assert.equal(calls, 1);
    }
  }
});
