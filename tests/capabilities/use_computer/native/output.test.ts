import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerOutput } from "../../../../packages/capabilities/use_computer/native/src/output.ts";
test("native output saves full text and PNGs, bounds images and preserves partial-operation diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-native-output-"));
  try {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
    const raw = "中文".repeat(30000);
    const result = await new ComputerOutput(root).format("session", {
      content: [
        { type: "text", text: raw },
        ...Array.from({ length: 5 }, () => ({ type: "image" as const, data: png, mimeType: "image/png" })),
      ],
      freshRuntime: false,
      operations: [{ method: "click", outcome: "accepted" }],
      error: { message: "failure" },
    });
    assert.equal(result.content.filter((c) => c.type === "image").length, 4);
    assert.equal((result.details.images as string[]).length, 4);
    assert.ok((await readFile(result.details.fullOutputPath as string, "utf8")).startsWith(raw));
    assert.match(
      result.content[0]!.type === "text" ? result.content[0]!.text : "",
      /Actions may have partially completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
