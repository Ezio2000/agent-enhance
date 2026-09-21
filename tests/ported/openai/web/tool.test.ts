import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { webTool } from "../../../../packages/capabilities/search_web/openai/src/tool.ts";
import { WebOutputStore } from "../../../../packages/capabilities/search_web/openai/src/output.ts";
import { ctx, fakeWebClient } from "../helpers.ts";

test("web adapter returns raw reference IDs, bounded content and saved full output", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-web-test-"));
  try {
    const text = "turn0search0 https://openai.com/\n" + "x".repeat(60000);
    const tool = webTool({
      artifacts: new WebOutputStore(root),
      client: () =>
        fakeWebClient((_path, body) => {
          assert.equal(body.id, "session");
          assert.equal(body.input, undefined);
          assert.equal(body.settings.user_location.type, "approximate");
          assert.equal(body.commands.search_query[0].q, "test");
          assert.equal(body.include_context, undefined);
          assert.equal(body.timeout_seconds, undefined);
          return { output: text, results: [{ url: "https://openai.com/" }] };
        }),
    });
    const result = await tool.execute(
      "call",
      { search_query: [{ q: "test" }], include_context: false, user_location: { country: "US" } },
      undefined,
      undefined,
      ctx(root),
    );
    assert.match((result.content[0] as { text: string }).text, /turn0search0/);
    assert.ok(Buffer.byteLength((result.content[0] as { text: string }).text) < 51000);
    assert.equal(await readFile(result.details!.fullOutputPath as string, "utf8"), text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
