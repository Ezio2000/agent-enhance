import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const MAX_BYTES = 512 * 1024;
/** Small inline preview via macOS `sips`; other platforms return no preview (the saved original is reported). */
export async function preview(
  bytes: Uint8Array,
  mime: string,
): Promise<{ data: string; mimeType: string } | null> {
  if (process.platform !== "darwin") return null;
  const dir = await mkdtemp(join(tmpdir(), "cc-enhance-preview-"));
  try {
    const input = join(dir, `in.${mime.split("/")[1] ?? "img"}`);
    await writeFile(input, bytes);
    for (const size of [1024, 768, 512]) {
      const output = join(dir, `out-${size}.jpg`);
      await promisify(execFile)(
        "sips",
        ["-Z", String(size), "-s", "format", "jpeg", input, "--out", output],
        {
          timeout: 20_000,
        },
      );
      const result = await readFile(output);
      if (result.length <= MAX_BYTES) return { data: result.toString("base64"), mimeType: "image/jpeg" };
    }
    return null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
