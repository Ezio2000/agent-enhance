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
    const artifact = JSON.parse(await readFile(result.details.fullOutputPath as string, "utf8"));
    assert.equal(artifact.text, raw + "\n\n[Screenshot omitted: maximum 4 images / 24 MiB per call.]");
    assert.deepEqual(artifact.operations, [{ method: "click", outcome: "accepted" }]);
    assert.equal(artifact.error.message, "failure");
    assert.match(
      (result.content[0] as { text: string }).text.slice(0, 2000),
      /FAILED[\s\S]*Full diagnostics/,
    );
    assert.match(
      result.content[0]!.type === "text" ? result.content[0]!.text : "",
      /Actions may have partially completed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("caught native failures produce complete diagnostics and retain cleanup without becoming a script error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ae-output-failures-"));
  try {
    const result = await new ComputerOutput(root).format("session", {
      content: [],
      freshRuntime: false,
      generation: "g",
      operations: [
        {
          method: "pressKey",
          target: { pid: 123, window: "w" },
          delivery: "pid-window",
          error: { code: "EFFECT_MISMATCH", message: "wrong range" },
        },
      ],
      cleanup: { releasedKeys: 1, releasedButtons: 1 },
    });
    assert.equal(result.details.status, "completed_with_operation_errors");
    const artifact = JSON.parse(await readFile(result.details.fullOutputPath as string, "utf8"));
    assert.deepEqual(artifact.cleanup, { releasedKeys: 1, releasedButtons: 1 });
    assert.match(
      (result.content[0] as { text: string }).text,
      /SCRIPT COMPLETED WITH NATIVE FAILURES[\s\S]*EFFECT_MISMATCH[\s\S]*123/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("post-dispatch isolation failures give read-only recovery without suggesting a settings change", async () => {
  const root = await mkdtemp(join(tmpdir(), "ae-output-isolation-"));
  try {
    const error = {
      code: "ISOLATION_VIOLATION",
      message: "Focus changed after dispatch",
      details: { dispatched: true, phase: "post_dispatch" },
    };
    const result = await new ComputerOutput(root).format("session", {
      content: [],
      freshRuntime: false,
      generation: "g",
      error,
      operations: [{ method: "click", error }],
    });
    assert.match(
      (result.content[0] as { text: string }).text,
      /Recovery: focus changed after dispatch[\s\S]*listWindows[\s\S]*do not replay input or change global isolation/,
    );
    const artifact = JSON.parse(await readFile(result.details.fullOutputPath as string, "utf8"));
    assert.equal(artifact.error.details.dispatched, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
