import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfTool } from "../packages/capabilities/view_pdf/opencode/src/tool.ts";
import { videoTool } from "../packages/capabilities/view_video/opencode/src/tool.ts";
import { ResponsesClient } from "../packages/transports/opencode/src/responses.ts";
import { StaticCredentialResolver } from "../packages/core/src/auth.ts";
import type { ExecutionContext } from "../packages/core/src/contracts.ts";
import { piHistory } from "../packages/hosts/pi/src/history.ts";

test("view tools send explicit input_file to their own provider and preserve local files", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-view-"));
  try {
    const ctx: ExecutionContext = {
      cwd: home,
      host: "test",
      sessionId: "view-test",
      credentials: new StaticCredentialResolver({}),
      model: { provider: "other", id: "other" },
    };
    const client = new ResponsesClient(
      async () => ({ baseUrl: "https://opencode.ai/zen/go/v1/", headers: {} }),
      async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.model, "muse-spark-1.3-contributor");
        assert.equal(payload.store, false);
        assert.match(new Headers(init?.headers).get("x-opencode-session")!, /^[a-f0-9-]+$/);
        assert.equal(payload.input[0].content[1].type, "input_file");
        assert.match(payload.input[0].content[1].file_data, /^data:(application\/pdf|video\/mp4);base64,/);
        return Response.json({ output: [{ content: [{ text: "Viewed test fixture" }] }] });
      },
    );
    await writeFile(join(home, "test.pdf"), "%PDF-1.4\nfixture");
    await writeFile(join(home, "test.mp4"), "fixture");
    for (const [tool, path] of [
      [pdfTool({ client: () => client }), "test.pdf"],
      [videoTool({ client: () => client }), "test.mp4"],
    ] as const) {
      const result = await tool.execute("call", { path, prompt: "Describe" }, undefined, undefined, ctx);
      assert.match(result.content[0]!.text!, /Viewed/);
      await assert.rejects(
        tool.execute("call", { path: "audio.mp3", prompt: "Describe" }, undefined, undefined, ctx),
      );
    }
    assert.deepEqual((await readdir(home)).sort(), ["test.mp4", "test.pdf"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("Pi history translation never passes system prompts, files, tool results or thinking to base", () => {
  const result = piHistory([
    { type: "message", message: { role: "system", content: "secret system" } },
    { type: "message", message: { role: "toolResult", content: "secret file" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "answer" },
        ],
      },
    },
    {
      type: "compaction",
      retainedTail: [
        {
          role: "user",
          content: [
            { type: "text", text: "question" },
            { type: "image", data: "secret" },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(result, [
    { role: "assistant", content: "answer" },
    { role: "user", content: "question" },
  ]);
});
