import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerOutput } from "../../../../packages/capabilities/use_computer/openai/src/output.ts";

test("computer output corrects runtime MIME, saves private originals, bounds text and screenshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "computer-output-test-"));
  try {
    const store = new ComputerOutput(root);
    const image = {
      type: "image",
      mimeType: "image/png",
      data: Buffer.from([255, 216, 255, 0, 1]).toString("base64"),
    };
    const r = await store.format("s", {
      content: [{ type: "text", text: "line\n".repeat(2500) }, ...Array(5).fill(image)],
    });
    assert.equal(r.content.filter((c) => c.type === "image").length, 4);
    assert.equal(r.content[1]!.type, "image");
    assert.equal((r.content[1] as any).mimeType, "image/jpeg");
    const path = (r.details.images as string[])[0]!;
    assert.ok(path.endsWith(".jpg"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path)).length, 5);
    assert.match((r.content[0] as any).text, /Truncated/);
    assert.match(await readFile(r.details.fullOutputPath as string, "utf8"), /Additional images omitted/);
    const error = await store.format("s", {
      isError: true,
      bridgeGeneration: "test-generation",
      bridgeFreshRuntime: true,
      bridgeRecovery: "Reinitialize app bindings; do not replay actions.",
      content: [{ type: "text", text: "partial failure" }],
    });
    assert.match((error.content[0] as any).text, /Fresh Computer runtime.*test-generation/);
    assert.match((error.content[0] as any).text, /Reinitialize app bindings/);
    assert.equal(error.details.recovery, "Reinitialize app bindings; do not replay actions.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
