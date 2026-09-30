import { readFile } from "node:fs/promises";
// esbuild replaces this module with an embedded payload; direct source execution reads the same archive.
export async function nativePayload(): Promise<Buffer> {
  return readFile(new URL("../../../../../dist/native/computer-runtime.json.gz", import.meta.url));
}
