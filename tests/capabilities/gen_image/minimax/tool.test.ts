import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityRegistry } from "../../../../packages/core/src/registry.ts";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";
import openai from "../../../../packages/capabilities/gen_image/openai/src/index.ts";
import xai from "../../../../packages/capabilities/gen_image/xai/src/index.ts";
import minimax from "../../../../packages/capabilities/gen_image/minimax/src/index.ts";
import { imageTool } from "../../../../packages/capabilities/gen_image/minimax/src/tool.ts";
import { ImageArtifactStore } from "../../../../packages/capabilities/gen_image/minimax/src/artifacts.ts";
import { ImageClient } from "../../../../packages/capabilities/gen_image/minimax/src/client.ts";
import { png as PNG } from "./fixture.ts";
import type { CapabilityModule } from "../../../../packages/core/src/contracts.ts";

const context = (cwd: string) =>
  ({
    cwd,
    model: { provider: "anthropic", id: "other" },
    sessionId: "session",
    host: "test",
  }) as unknown as ExecutionContext;

test("tool saves the original and appends a preview; no fabricated quota line", async () => {
  const root = await mkdtemp(join(tmpdir(), "minimax-image-tool-"));
  try {
    const client = {
      images: async () => ({
        data: {
          imageBase64: [PNG().toString("base64")],
          metadata: { success_count: "1", failed_count: "0" },
        },
        requestId: "req-7",
      }),
    } as unknown as ImageClient;
    const tool = imageTool({
      artifacts: new ImageArtifactStore(root),
      client: () => client,
      preview: async () => ({ data: PNG().toString("base64"), mimeType: "image/png" }),
    });
    const updates: string[] = [];
    const result = await tool.execute(
      "call",
      { prompt: "blue circle", aspect_ratio: "1:1", prompt_optimizer: true, timeout_seconds: 30 },
      undefined,
      (u) => updates.push(String(u.content[0]?.text)),
      context(root),
    );
    assert.ok(updates.length >= 1);
    assert.match(updates[0]!, /Generating image with image-01/);
    const text = String(result.content[0]!.text);
    assert.match(text, /Image 1: .*image-1\.png \(4x4\)/);
    assert.match(text, /"blue circle" · image-01 · elapsed [\d.]+s\n/);
    assert.doesNotMatch(text, /quota/); // media quota is server-side; never fabricated
    assert.equal(result.content[1]!.type, "image");
    const saved = (result.details!.images as { path: string }[])[0]!;
    assert.deepEqual(await readFile(saved.path), PNG());
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
    assert.equal((result.details as Record<string, any>).requestId, "req-7");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("three providers merge into one tool; minimax options route and native limits apply", async () => {
  const registry = new CapabilityRegistry({ gen_image: "minimax" });
  const services = { artifactRoot: "/unused" };
  const seen: string[] = [];
  const wrap = (original: CapabilityModule, name: string): CapabilityModule => ({
    ...original,
    create(s) {
      const instance = original.create(s);
      instance.tool = {
        ...instance.tool!,
        execute: async (_id, args) => {
          seen.push(name);
          return { content: [{ type: "text", text: "ok" }], details: {} };
        },
      };
      return instance;
    },
  });
  registry.load(wrap(openai, "openai"), services);
  registry.load(wrap(xai, "xai"), services);
  registry.load(wrap(minimax, "minimax"), services);
  const tools = registry.tools();
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.deepEqual(tool.parameters.properties.provider.enum, ["openai", "xai", "minimax"]);
  assert.ok(tool.parameters.properties.model.enum.includes("image-01"));
  assert.ok(tool.parameters.properties.model.enum.includes("gpt-image-2.5-flare"));
  assert.deepEqual(Object.keys(tool.parameters.properties.options.properties).sort(), [
    "minimax",
    "openai",
    "xai",
  ]);
  // Routing via saved default resolves options.minimax into native args.
  const ok = await tool.execute(
    "x",
    { prompt: "p", options: { minimax: { aspect_ratio: "9:16", seed: 7 } } },
    undefined,
    undefined,
    context("/unused"),
  );
  assert.equal(ok.details.provider, "minimax");
  assert.deepEqual(seen, ["minimax"]);
  // minimax has no images field: edits are rejected before any network call.
  await assert.rejects(
    tool.execute("x", { prompt: "p", images: [{ path: "a.png" }] }, undefined, undefined, context("/unused")),
    /PROVIDER_ARGUMENTS/,
  );
  assert.deepEqual(seen, ["minimax"]);
});

test("bad inputs fail before any client call and leave no artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "minimax-image-invalid-"));
  try {
    const tool = imageTool({
      artifacts: new ImageArtifactStore(root),
      client: () => {
        throw new Error("unexpected network");
      },
    });
    for (const args of [
      { prompt: " " },
      { prompt: "x".repeat(1501) },
      { prompt: "x", aspect_ratio: "21:10" },
      { prompt: "x", seed: 1.5 },
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
