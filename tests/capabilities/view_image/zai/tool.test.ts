import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewImageTool, VISION_MODEL } from "../../../../packages/capabilities/view_image/zai/src/tool.ts";
import type {
  VisionClient,
  VisionRequest,
} from "../../../../packages/capabilities/view_image/zai/src/client.ts";
import type { ExecutionContext } from "../../../../packages/core/src/contracts.ts";

const context: ExecutionContext = {
  cwd: process.cwd(),
  sessionId: "s1",
  host: "test",
  credentials: { resolve: async () => ({ status: "missing", guidance: "x" }) },
};

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fakeClient() {
  const requests: VisionRequest[] = [];
  const client = {
    async analyze(request: VisionRequest) {
      requests.push(request);
      return {
        content: "Maroon",
        finishReason: "stop",
        usage: {
          prompt_tokens: 39,
          completion_tokens: 10,
          total_tokens: 49,
          completion_tokens_details: { reasoning_tokens: 6 },
        },
        requestId: "vr-1",
        model: VISION_MODEL,
      };
    },
  } as unknown as VisionClient;
  return { client, requests };
}

test("assembles system prompt, base64 data URL and task hints; reports usage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "view-image-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })));
  const path = join(dir, "pixel.png");
  await writeFile(path, png1x1);
  const { client, requests } = fakeClient();
  const tool = viewImageTool({ client: () => client });
  const result = await tool.execute(
    "c1",
    {
      task: "extract_text",
      prompt: "Read the color name",
      image: { path },
      language: "python",
      thinking: "disabled",
      max_tokens: 512,
    },
    undefined,
    undefined,
    context,
  );
  assert.equal(
    result.content[0] && result.content[0].type === "text" ? result.content[0].text : "",
    "Maroon",
  );
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.model, VISION_MODEL);
  assert.equal(request.thinking.type, "disabled");
  assert.equal(request.max_tokens, 512);
  const [system, user] = request.messages;
  assert.equal(system!.role, "system");
  assert.ok(String(system!.content).length > 500); // vendored specialist prompt
  const parts = user!.content as unknown as { type: string; text?: string; image_url?: { url: string } }[];
  assert.equal(parts[0]!.type, "image_url");
  assert.match(parts[0]!.image_url!.url, /^data:image\/png;base64,/);
  assert.match(parts[1]!.text!, /Read the color name/);
  assert.match(parts[1]!.text!, /language_hint/);
  assert.deepEqual(result.details, {
    version: 1,
    status: "completed",
    task: "extract_text",
    model: VISION_MODEL,
    thinking: "disabled",
    finishReason: "stop",
    usage: { promptTokens: 39, completionTokens: 10, reasoningTokens: 6, totalTokens: 49 },
    requestId: "vr-1",
  });
});

test("task-specific validation: output_type, image2, video guard rails", async () => {
  const { client } = fakeClient();
  const tool = viewImageTool({ client: () => client });
  await assert.rejects(
    tool.execute(
      "c1",
      { task: "ui_to_artifact", prompt: "p", image: { url: "https://x/1.png" } },
      undefined,
      undefined,
      context,
    ),
    /requires output_type/,
  );
  await assert.rejects(
    tool.execute(
      "c1",
      { task: "ui_diff_check", prompt: "p", image: { url: "https://x/1.png" } },
      undefined,
      undefined,
      context,
    ),
    /requires image2/,
  );
  await assert.rejects(
    tool.execute(
      "c1",
      {
        task: "image_analysis",
        prompt: "p",
        image: { url: "https://x/1.png" },
        image2: { url: "https://x/2.png" },
      },
      undefined,
      undefined,
      context,
    ),
    /image2 is only accepted with ui_diff_check/,
  );
  await assert.rejects(
    tool.execute("c1", { task: "image_analysis", prompt: "p" }, undefined, undefined, context),
    /Provide image/,
  );
  await assert.rejects(
    tool.execute(
      "c1",
      { task: "image_analysis", prompt: "p", image: { url: "https://x/clip.mp4" } },
      undefined,
      undefined,
      context,
    ),
    /Videos are only accepted with task video_analysis/,
  );
});

test("ui_diff_check sends both images; remote URLs pass through without local reads", async () => {
  const { client, requests } = fakeClient();
  const tool = viewImageTool({ client: () => client });
  await tool.execute(
    "c1",
    {
      task: "ui_diff_check",
      prompt: "compare layouts",
      image: { url: "https://x/expected.png" },
      image2: { url: "https://x/actual.png" },
    },
    undefined,
    undefined,
    context,
  );
  const user = requests[0]!.messages[1]!;
  const parts = user.content as unknown as { type: string; image_url?: { url: string } }[];
  assert.deepEqual(
    parts.filter((p) => p.type === "image_url").map((p) => p.image_url?.url),
    ["https://x/expected.png", "https://x/actual.png"],
  );
});

test("ui_to_artifact picks the vendored prompt for the requested output_type", async () => {
  const { client, requests } = fakeClient();
  const tool = viewImageTool({ client: () => client });
  await tool.execute(
    "c1",
    { task: "ui_to_artifact", prompt: "recreate", image: { url: "https://x/ui.png" }, output_type: "spec" },
    undefined,
    undefined,
    context,
  );
  assert.match(String(requests[0]!.messages[0]!.content), /spec/i);
});
