import test from "node:test";
import assert from "node:assert/strict";
import { imageWarnings } from "../../../../packages/capabilities/gen_image/openai/src/warnings.ts";
import { ImageClient } from "../../../../packages/capabilities/gen_image/openai/src/client.ts";
import { imageWireOptions } from "../../../../packages/capabilities/gen_image/openai/src/tool.ts";

test("backend's ignored format, dimensions, count and metadata become explicit warnings", () => {
  const warnings = imageWarnings(
    {
      model: "gpt-image-2",
      prompt: "test",
      output_format: "png",
      size: "1024x1024",
      background: "transparent",
      n: 1,
    },
    {
      data: [{ b64_json: "x" }, { b64_json: "y" }],
      background: "opaque",
      size: "1024x1024",
      output_format: "png",
    },
    [{ mimeType: "image/jpeg", width: 1254, height: 1254 }],
  );
  assert.equal(warnings.length, 4);
  assert.match(warnings.join("\n"), /actual output is jpeg/);
  assert.match(warnings.join("\n"), /1254x1254/);
  assert.match(warnings.join("\n"), /background=transparent/);
});

test("a non-streaming response to stream:true is not silently reported as streaming", async () => {
  const client = new ImageClient(
    async () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/", headers: {} }),
    async () =>
      new Response('{"data":[{"b64_json":"aGVsbG8="}]}', { headers: { "content-type": "application/json" } }),
  );
  const result = await client.images({ model: "gpt-image-2", prompt: "test", stream: true });
  assert.match(result.data.warnings![0]!, /non-streaming JSON/);
});

test("explicit low quality still warns when the backend reports medium", () => {
  const warnings = imageWarnings(imageWireOptions({ prompt: "test", quality: "low" }), {
    data: [{ b64_json: "x" }],
    quality: "medium",
    output_format: "png",
  });
  assert.match(warnings.join("\n"), /Requested quality=low, but the backend reports medium/);
  assert.deepEqual(
    imageWarnings(imageWireOptions({ prompt: "test" }), { data: [{ b64_json: "x" }], quality: "high" }),
    [],
  );
});
