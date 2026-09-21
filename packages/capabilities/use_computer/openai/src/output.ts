import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactDirectories } from "../../../../transports/openai/src/artifacts.ts";
import { truncateText } from "../../../../transports/openai/src/output.ts";
import type { Json } from "./mcp.ts";
import { computerDocumentation } from "./documentation.ts";

export type ComputerContent =
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export class ComputerOutput extends ArtifactDirectories {
  async format(
    sessionId: string,
    result: Json,
  ): Promise<{ content: ComputerContent[]; details: Record<string, unknown> }> {
    if (!Array.isArray(result.content)) throw new Error("Computer runtime returned invalid content.");
    let directory: string | undefined;
    const dir = async () => (directory ??= await this.directory(sessionId));
    const content: ComputerContent[] = [];
    const images: string[] = [];
    const texts: string[] = [];
    let imageBytes = 0;
    for (const block of result.content) {
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      else if (block.type === "image" && typeof block.data === "string") {
        if (images.length >= 4) {
          texts.push("[Additional images omitted: maximum 4 screenshots per call.]");
          continue;
        }
        const bytes = Buffer.from(block.data, "base64");
        const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            ? "image/jpeg"
            : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"
              ? "image/webp"
              : undefined;
        if (!mimeType) {
          texts.push("[Unsupported screenshot encoding omitted.]");
          continue;
        }
        imageBytes += bytes.length;
        if (imageBytes > 24 * 1024 * 1024) {
          texts.push("[Screenshot omitted: 24 MiB per-call image limit.]");
          continue;
        }
        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";
        const path = join(await dir(), `screenshot-${images.length + 1}.${extension}`);
        await writeFile(path, bytes, { mode: 0o600 });
        images.push(path);
        content.push({ type: "image", data: bytes.toString("base64"), mimeType });
      } else
        texts.push(
          `[Unsupported MCP content ${String(block.type)} omitted; external resources are not fetched.]`,
        );
    }
    const raw = computerDocumentation(texts.join("\n\n"));
    const bounded = truncateText(raw);
    let fullOutputPath: string | undefined;
    if (bounded.truncated) {
      fullOutputPath = join(await dir(), "output.txt");
      await writeFile(fullOutputPath, raw, { mode: 0o600 });
    }
    const text = [
      result.isError
        ? "Computer runtime reported an error. Actions may have partially completed; inspect state before retrying."
        : "",
      result.bridgeFreshRuntime
        ? `Fresh Computer runtime (generation ${result.bridgeGeneration}). Previous JS variables/app bindings were not retained.`
        : "",
      typeof result.bridgeRecovery === "string" ? result.bridgeRecovery : "",
      bounded.text,
      fullOutputPath ? `[Truncated to 2000 lines / 48 KiB. Full output: ${fullOutputPath}]` : "",
      images.length ? `Screenshots: ${images.join(", ")}` : "",
      result.isError && result.bridgeApprovals
        ? `Computer approval diagnostics: ${JSON.stringify(result.bridgeApprovals)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    content.unshift({
      type: "text",
      text: text || "Computer operation completed with no output. Observe the UI to verify the result.",
    });
    return {
      content,
      details: {
        status: result.isError ? "error" : "completed",
        generation: result.bridgeGeneration,
        freshRuntime: result.bridgeFreshRuntime,
        recovery: result.bridgeRecovery,
        approvalMode: result.bridgeApprovalMode,
        images,
        fullOutputPath,
        approvals: result.bridgeApprovals,
      },
    };
  }
}
