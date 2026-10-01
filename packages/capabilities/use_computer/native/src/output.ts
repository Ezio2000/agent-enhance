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
      const path = join(await dir(), "screenshot-" + (images.length + 1) + ".png");
      await writeFile(path, bytes);
      images.push(path);
      content.push({ type: "image", data: block.data, mimeType: "image/png" });
    }
    const raw = texts.join("\n\n");
    let bounded = raw.split("\n").slice(0, 2000).join("\n");
    if (Buffer.byteLength(bounded) > 48 * 1024)
      bounded = Buffer.from(bounded)
        .subarray(0, 48 * 1024)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
    const failures = result.operations.filter((operation) => operation.error);
    const diagnostic = !!result.error || failures.length > 0;
    let fullOutputPath: string | undefined;
    if (diagnostic) {
      fullOutputPath = join(await dir(), "diagnostics.json");
      await writeFile(
        fullOutputPath,
        JSON.stringify(
          {
            generation: result.generation,
            freshRuntime: result.freshRuntime,
            error: result.error,
            operations: result.operations,
            cleanup: result.cleanup,
            text: raw,
            images,
          },
          null,
          2,
        ),
      );
    } else if (bounded !== raw) {
      fullOutputPath = join(await dir(), "output.txt");
      await writeFile(fullOutputPath, raw);
    }
    const failure = result.error ?? failures.at(-1)?.error;
    const operation = failures.at(-1) ?? result.operations.at(-1);
    const summary = diagnostic
      ? [
          result.error ? "FAILED" : "SCRIPT COMPLETED WITH NATIVE FAILURES",
          String(failure?.code ?? "SCRIPT_ERROR") +
            ": " +
            String(failure?.message ?? "")
              .split("\n")[0]!
              .slice(0, 400),
          "Generation: " +
            (result.generation ?? "startup failed") +
            ". Target/route: " +
            JSON.stringify(failure?.details?.target ?? operation?.target ?? {}).slice(0, 300) +
            " / " +
            (failure?.details?.delivery ?? operation?.delivery ?? "see diagnostics") +
            ".",
          "Native failures: " +
            failures.length +
            ". Cleanup: " +
            JSON.stringify({
              reason: result.cleanup?.reason,
              releasedKeys: result.cleanup?.releasedKeys,
              releasedButtons: result.cleanup?.releasedButtons,
              releaseErrors: result.cleanup?.releaseErrors?.length ?? 0,
              nativeStopped: result.cleanup?.nativeStopped,
              workerStopped: result.cleanup?.workerStopped,
            }),
          "Full diagnostics: " + fullOutputPath,
          "Actions may have partially completed. Observe before continuing; no action was replayed.",
          failure?.code === "ISOLATION_VIOLATION"
            ? "Recovery: focus changed after dispatch. Read getState, listWindows and observe, including related modal windows; do not replay input or change global isolation settings to recover a read-only task."
            : "",
          failure?.details?.focusRecoveryAvailable === true
            ? "focusRecoveryAvailable:true. After checking completed effects, call computer.restoreUserFocus() to return to the displaced app/window, then observe freshly before continuing."
            : "",
        ].join("\n")
      : "";
    const text = [
      summary,
      result.freshRuntime
        ? "Fresh native computer runtime (" + (result.generation ?? "startup failed") + ")."
        : "",
      bounded,
      fullOutputPath && !diagnostic
        ? "[Truncated to 2000 lines / 48 KiB. Full output: " + fullOutputPath + "]"
        : "",
      images.length ? "Screenshots: " + images.join(", ") : "",
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
        status: result.error ? "error" : failures.length ? "completed_with_operation_errors" : "completed",
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
