import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";
import { videoTool } from "../../../../packages/capabilities/gen_video/xai/src/tool.ts";
import { VideoClient } from "../../../../packages/capabilities/gen_video/xai/src/client.ts";
import { VideoArtifactStore } from "../../../../packages/capabilities/gen_video/xai/src/artifacts.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9P8AAAAASUVORK5CYII=",
  "base64",
);
const mp4 = Buffer.from("fake-mp4");
const auth = async () => ({ baseUrl: "https://api.x.ai/v1/", headers: { Authorization: "Bearer test" } });
const context = (cwd: string) =>
  ({
    cwd,
    model: { provider: "anthropic" },
    sessionId: "session",
    host: "test",
  }) as unknown as ExecutionContext;

function respondingClient(assertStart: (url: string, body: Record<string, unknown>) => void) {
  return new VideoClient(
    auth,
    async (url, init) => {
      const u = String(url);
      if (u.endsWith("/videos/generations")) {
        assertStart(u, JSON.parse(String(init?.body)));
        return Response.json({ request_id: "vid-1" });
      }
      if (u.endsWith("/videos/vid-1"))
        return Response.json({ status: "done", video: { url: "https://cdn.example/out.mp4" } });
      if (u === "https://cdn.example/out.mp4") return new Response(mp4);
      throw new Error(`unexpected url ${u}`);
    },
    0,
  );
}

test("image-to-video omits aspect_ratio and writes only the original mp4", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-video-"));
  try {
    await writeFile(join(root, "source.png"), png);
    let progress = 0;
    const tool = videoTool({
      artifacts: new VideoArtifactStore(root),
      client: () =>
        respondingClient((url, body) => {
          assert.equal(url, "https://api.x.ai/v1/videos/generations");
          assert.equal("aspect_ratio" in body, false);
          assert.equal("reference_images" in body, false);
          assert.deepEqual(body, {
            model: "grok-imagine-video-1.5",
            prompt: "camera push-in",
            duration: 10,
            resolution: "720p",
            image: { url: `data:image/png;base64,${png.toString("base64")}` },
          });
        }),
    });
    const result = await tool.execute(
      "call",
      {
        prompt: "camera push-in",
        image: { path: "source.png" },
        duration: 10,
        resolution: "720p",
        timeout_seconds: 20,
      },
      undefined,
      () => {
        progress++;
      },
      context(root),
    );
    assert.ok(progress > 0);
    assert.equal(result.details.operation, "image_to_video");
    assert.equal(result.details.requestId, "vid-1");
    const saved = result.details.video as { path: string };
    assert.deepEqual(await readFile(saved.path), mp4);
    assert.deepEqual(await readdir(join(saved.path, "..")), ["video-1.mp4"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference-to-video sends url objects, voices, keyframes and required aspect_ratio", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-r2v-"));
  try {
    await writeFile(join(root, "person.png"), png);
    await writeFile(join(root, "closeup.png"), png);
    const tool = videoTool({
      artifacts: new VideoArtifactStore(root),
      client: () =>
        respondingClient((_url, body) => {
          assert.deepEqual(body, {
            model: "grok-imagine-video-1.5",
            prompt: "The person from <IMAGE_1> walks, speaking with <AUDIO_0>",
            duration: 6,
            resolution: "480p",
            image: { url: `data:image/png;base64,${png.toString("base64")}` },
            aspect_ratio: "16:9",
            reference_images: [{ url: `data:image/png;base64,${png.toString("base64")}` }],
            reference_audios: [{ voice_id: "eve" }],
            last_frame: { url: "https://example.com/end.png" },
            keyframes: [
              { image: { url: `data:image/png;base64,${png.toString("base64")}` }, timestamp_s: 2 },
            ],
          });
        }),
    });
    const result = await tool.execute(
      "call",
      {
        prompt: "The person from <IMAGE_1> walks, speaking with <AUDIO_0>",
        image: { path: "person.png" },
        images: [{ path: "person.png" }],
        last_frame: { image_url: "https://example.com/end.png" },
        keyframes: [{ image: { path: "closeup.png" }, timestamp_s: 2 }],
        voices: ["eve"],
        aspect_ratio: "16:9",
      },
      undefined,
      undefined,
      context(root),
    );
    assert.equal(result.details.operation, "reference_to_video");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bad inputs fail before authentication/network and leave no artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-video-invalid-"));
  try {
    const tool = videoTool({
      artifacts: new VideoArtifactStore(root),
      client: () => {
        throw new Error("unexpected network");
      },
    });
    for (const args of [
      {},
      { prompt: "x" },
      { prompt: "x", images: [{ path: "a.png" }] },
      { prompt: "x", image: { path: "a.png" }, duration: 8 },
      { prompt: "x", images: [{ path: "a.png", image_url: "https://example.com/a" }], aspect_ratio: "16:9" },
      { prompt: "x", images: [{ path: "a.png" }], aspect_ratio: "21:9" },
      {
        prompt: "x",
        voices: ["eve"],
        aspect_ratio: "16:9",
        keyframes: [{ image: { path: "a.png" }, timestamp_s: 0 }],
      },
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

test("empty videos are not saved; parallel calls never overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "grok-video-save-"));
  try {
    const store = new VideoArtifactStore(root);
    await assert.rejects(store.saveVideo("session", new Uint8Array()));
    assert.deepEqual(await readdir(root), []);
    const tool = videoTool({ artifacts: store, client: () => respondingClient(() => {}) });
    const results = await Promise.all(
      [1, 2].map((i) =>
        tool.execute(
          String(i),
          { prompt: "walk", image: { image_url: "https://example.com/a.png" } },
          undefined,
          undefined,
          context(root),
        ),
      ),
    );
    const paths = results.map((result) => (result.details.video as { path: string }).path);
    assert.notEqual(paths[0], paths[1]);
    for (const path of paths) assert.deepEqual(await readFile(path), mp4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
