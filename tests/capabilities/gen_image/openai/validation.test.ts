import test from "node:test";
import assert from "node:assert/strict";
import { validateImageRequest } from "../../../../packages/capabilities/gen_image/openai/src/validation.ts";
import {
  IMAGE_DEFAULTS,
  type ImageRequest,
} from "../../../../packages/capabilities/gen_image/openai/src/types.ts";
import { image } from "../../../fixtures/openai/helpers.ts";

test("image constraints follow current public docs, not older fixed-size assumptions", () => {
  for (const size of ["auto", "1024x1024", "2048x1152", "3840x2160", "2160x3840"])
    assert.doesNotThrow(() => validateImageRequest({ ...image, size }));
  for (const size of ["512x512", "1025x1024", "4096x2048", "3840x3840", "3840x512", "bad"])
    assert.throws(() => validateImageRequest({ ...image, size }));
  for (const options of [
    { n: 0 },
    { n: 2 },
    { output_compression: 50 },
    { output_format: "jpeg" },
    { partial_images: 1 },
    { stream: false },
    { quality: "invalid" },
    { model: "gpt-image-1.5" },
    { moderation: "off" },
    { images: [{ file_id: "f" }] },
    { mask: { image_url: "https://example.com/m.png" } },
    { input_fidelity: "high" },
    { user: "test" },
  ])
    assert.throws(() => validateImageRequest({ ...image, ...options } as unknown as ImageRequest));
  assert.doesNotThrow(() =>
    validateImageRequest({
      ...image,
      ...IMAGE_DEFAULTS,
      images: [{ image_url: "https://example.com/i.png" }],
    }),
  );
});
