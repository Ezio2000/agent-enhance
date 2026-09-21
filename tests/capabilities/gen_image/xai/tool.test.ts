import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";
import { imageTool } from "../../../../packages/capabilities/gen_image/xai/src/tool.ts";
import { ImageClient } from "../../../../packages/capabilities/gen_image/xai/src/client.ts";
import { ImageArtifactStore } from "../../../../packages/capabilities/gen_image/xai/src/artifacts.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9P8AAAAASUVORK5CYII=",
  "base64",
);
const auth = async () => ({ baseUrl: "https://api.x.ai/v1/", headers: { Authorization: "Bearer test" } });
const context = (cwd: string) =>
  ({
    cwd,
    model: { provider: "anthropic" },
    sessionId: "session",
    host: "test",
  }) as unknown as ExecutionContext;

test("generation writes only the original, returns a preview and omits edit/timeout fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-tool-"));
  try {
    let progress = 0;
    const tool = imageTool({
      artifacts: new ImageArtifactStore(root),
      preview: async () => ({ data: png.toString("base64"), mimeType: "image/png" }),
      client: () =>
        new ImageClient(auth, async (url, init) => {
          assert.equal(String(url), "https://api.x.ai/v1/images/generations");
          const body = JSON.parse(String(init?.body));
          assert.deepEqual(body, {
            model: "grok-imagine-image-2.0",
            prompt: "blue square",
            n: 1,
            response_format: "b64_json",
            resolution: "2k",
            aspect_ratio: "1:1",
            quality: "medium",
          });
          return Response.json(
            { data: [{ b64_json: png.toString("base64") }] },
            { headers: { "x-request-id": "request-1" } },
          );
        }),
    });
    const result = await tool.execute(
      "call",
      {
        prompt: "blue square",
        resolution: "2k",
        aspect_ratio: "1:1",
        quality: "medium",
        timeout_seconds: 20,
      },
      undefined,
      () => {
        progress++;
      },
      context(root),
    );
    assert.ok(progress > 0);
    assert.equal(result.details.operation, "generate");
    assert.equal(result.details.requestId, "request-1");
    assert.equal(result.content[1]?.type, "image");
    const [saved] = result.details.images as { path: string }[];
    assert.deepEqual(await readFile(saved!.path), png);
    assert.deepEqual(await readdir(join(saved!.path, "..")), ["image-1.png"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("single and multi-reference edits use Grok image/images objects and preserve input files", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-edit-"));
  try {
    await writeFile(join(root, "reference.png"), png);
    for (const count of [1, 2]) {
      const tool = imageTool({
        artifacts: new ImageArtifactStore(root),
        client: () =>
          new ImageClient(auth, async (url, init) => {
            assert.match(String(url), /images\/edits$/);
            const body = JSON.parse(String(init?.body));
            const references = count === 1 ? [body.image] : body.images;
            assert.equal(references.length, count);
            assert.equal(count === 1 ? body.images : body.image, undefined);
            assert.equal(body.aspect_ratio, undefined);
            assert.equal(references[0].type, "image_url");
            assert.equal(references[0].url, `data:image/png;base64,${png.toString("base64")}`);
            if (count === 2) assert.equal(references[1].url, "https://example.com/source.png");
            return Response.json({ data: [{ b64_json: png.toString("base64") }] });
          }),
      });
      const result = await tool.execute(
        "call",
        {
          prompt: "make green",
          images: [
            { path: "reference.png" },
            ...(count === 2 ? [{ image_url: "https://example.com/source.png" }] : []),
          ],
        },
        undefined,
        undefined,
        context(root),
      );
      assert.equal(result.details.operation, "edit");
    }
    assert.deepEqual(await readFile(join(root, "reference.png")), png);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bad inputs fail before authentication/network and leave no artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-invalid-"));
  try {
    const tool = imageTool({
      artifacts: new ImageArtifactStore(root),
      client: () => {
        throw new Error("unexpected network");
      },
    });
    for (const args of [
      { prompt: " " },
      { prompt: "x", n: 2 },
      { prompt: "x", images: [{}] },
      { prompt: "x", images: [{ path: "a", image_url: "https://example.com/a" }] },
      { prompt: "x", model: "grok-imagine-image-quality", quality: "auto" },
      { prompt: "x", images: Array.from({ length: 6 }, () => ({ path: "a" })) },
    ]) {
      await assert.rejects(
        tool.execute("call", args as never, undefined, undefined, context(root)),
        (error) => error instanceof Error && !error.message.includes("unexpected network"),
      );
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed images are not saved; preview failures preserve valid originals; parallel calls never overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-save-"));
  try {
    const store = new ImageArtifactStore(root);
    await assert.rejects(store.saveImage("session", "bm90IGFuIGltYWdl"));
    assert.deepEqual(await readdir(root), []);
    const tool = imageTool({
      artifacts: store,
      preview: async () => {
        throw new Error("preview unavailable");
      },
      client: () =>
        new ImageClient(auth, async () => Response.json({ data: [{ b64_json: png.toString("base64") }] })),
    });
    const results = await Promise.all(
      [1, 2].map((i) =>
        tool.execute(String(i), { prompt: "blue square" }, undefined, undefined, context(root)),
      ),
    );
    const paths = results.map((result) => (result.details.images as { path: string }[])[0]!.path);
    assert.notEqual(paths[0], paths[1]);
    for (const path of paths) assert.deepEqual(await readFile(path), png);
    assert.ok(results.every((result) => result.content.length === 1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
