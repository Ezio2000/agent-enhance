import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Content, ToolResult } from "../../../../core/src/contracts.ts";
import type { ComputerResult } from "./session.ts";
export class ComputerOutput {
  constructor(private root: string) {}
  async format(sessionId: string, result: ComputerResult): Promise<ToolResult> {
    let directory: string | undefined;
    const dir = async () => {
      if (!directory) {
        const parent = join(
          this.root,
          sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "ephemeral",
        );
        await mkdir(parent, { recursive: true });
        directory = await mkdtemp(join(parent, "call-"));
      }
      return directory;
    };
    const content: Content[] = [],
      images: string[] = [],
      texts: string[] = [];
    let totalBytes = 0;
    for (const block of result.content) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      if (block.type !== "image" || typeof block.data !== "string") continue;
      const bytes = Buffer.from(block.data, "base64");
      if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        texts.push("[Invalid native PNG screenshot omitted.]");
        continue;
      }
      if (images.length >= 4 || totalBytes + bytes.length > 24 * 1024 * 1024) {
        texts.push("[Screenshot omitted: maximum 4 images / 24 MiB per call.]");
        continue;
      }
      totalBytes += bytes.length;
      const path = join(await dir(), `screenshot-${images.length + 1}.png`);
      await writeFile(path, bytes);
      images.push(path);
      content.push({ type: "image", data: block.data, mimeType: "image/png" });
    }
    const raw = texts.join("\n\n");
    const lines = raw.split("\n");
    let bounded = lines.slice(0, 2000).join("\n");
    if (Buffer.byteLength(bounded) > 48 * 1024) {
      bounded = Buffer.from(bounded)
        .subarray(0, 48 * 1024)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
    }
    let fullOutputPath: string | undefined;
    if (bounded !== raw) {
      fullOutputPath = join(await dir(), "output.txt");
      await writeFile(fullOutputPath, raw);
    }
    const text = [
      result.freshRuntime ? `Fresh native computer runtime (${result.generation ?? "startup failed"}).` : "",
      bounded,
      result.error
        ? `${result.error.message}\nActions may have partially completed. Observe before continuing; no action was replayed.\nOperations: ${JSON.stringify(result.operations)}`
        : result.operations.some((operation) => operation.error)
          ? `Native operation failures handled by the script: ${JSON.stringify(result.operations.filter((operation) => operation.error))}. Observe to verify the final state.`
          : "",
      fullOutputPath ? `[Truncated to 2000 lines / 48 KiB. Full output: ${fullOutputPath}]` : "",
      images.length ? `Screenshots: ${images.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    content.unshift({
      type: "text",
      text: text || "Computer script completed with no output. Observe to verify effects.",
    });
    return {
      content,
      details: {
        status: result.error ? "error" : "completed",
        generation: result.generation,
        freshRuntime: result.freshRuntime,
        operations: result.operations,
        cleanup: result.cleanup,
        images,
        fullOutputPath,
      },
    };
  }
}
