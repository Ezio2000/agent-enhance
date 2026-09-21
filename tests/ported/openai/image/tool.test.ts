import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { imageTool } from "../../../../packages/capabilities/gen_image/openai/src/tool.ts";
import { ImageArtifactStore } from "../../../../packages/capabilities/gen_image/openai/src/artifacts.ts";
import { IMAGE_DEFAULTS } from "../../../../packages/capabilities/gen_image/openai/src/types.ts";
import { png } from "../fixtures.ts";
import { ctx, fakeImageClient } from "../helpers.ts";

test("image adapter sends image JSON, saves originals, returns previews and persists metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-tool-test-"));
  try {
    await writeFile(join(root, "source.png"), png());
    const tool = imageTool({
      artifacts: new ImageArtifactStore(root),
      client: () =>
        fakeImageClient((path, body) => {
          assert.match(path, /images\/edits$/);
          assert.match(body.images[0].image_url, /^data:image\/png/);
          for (const [key, value] of Object.entries({ ...IMAGE_DEFAULTS, quality: "high" }))
            assert.equal(body[key], value);
          for (const key of ["mask", "output_compression", "input_fidelity", "user"])
            assert.equal(key in body, false);
          assert.equal(body.images[0].path, undefined);
          assert.equal(body.timeout_seconds, undefined);
          return {
            data: [{ b64_json: png().toString("base64") }],
            output_format: "png",
            usage: { total_tokens: 10 },
          };
        }),
      preview: async () => ({ data: png().toString("base64"), mimeType: "image/png" }),
    });
    const result = await tool.execute(
      "call",
      { prompt: "Make blue", images: [{ path: "source.png" }], quality: "high" },
      undefined,
      undefined,
      ctx(root),
    );
    assert.equal(result.content[1]?.type, "image");
    assert.equal(result.details!.operation, "edit");
    assert.deepEqual(result.details!.usage, { total_tokens: 10 });
    assert.doesNotMatch(JSON.stringify(result.details), /b64_json|data:image|Bearer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
