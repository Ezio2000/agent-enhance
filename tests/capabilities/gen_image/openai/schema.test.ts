import test from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { ImageSchema } from "../../../../packages/capabilities/gen_image/openai/src/schema.ts";
import { IMAGE_DEFAULTS } from "../../../../packages/capabilities/gen_image/openai/src/types.ts";

test("schemas expose the reduced image controls and reject obsolete arguments", () => {
  assert.ok(
    Value.Check(ImageSchema, {
      prompt: "hello",
      images: [{ path: "a.png" }],
      size: "1024x1536",
      background: "transparent",
    }),
  );
  for (const options of [
    { ...IMAGE_DEFAULTS },
    { model: "gpt-image-unknown" },
    { n: 1 },
    { quality: "invalid" },
    { output_format: "png" },
    { stream: true },
    { partial_images: 0 },
    { moderation: "off" },
    { mask: { path: "mask.png" } },
    { images: [{ file_id: "file-test" }] },
    { output_compression: 60 },
    { input_fidelity: "high" },
    { user: "test" },
  ])
    assert.equal(Value.Check(ImageSchema, { prompt: "hello", ...options }), false);
  assert.equal(Value.Check(ImageSchema, { prompt: "hello", endpoint: "https://evil.example" }), false);
  assert.equal(Value.Check(ImageSchema, { prompt: "hello", output_format: "tiff" }), false);
  assert.equal(Value.Check(ImageSchema, { prompt: "hello", n: 11 }), false);
});
