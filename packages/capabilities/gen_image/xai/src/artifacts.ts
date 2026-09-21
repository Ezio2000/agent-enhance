import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ImageSource } from "./schema.ts";
import type { ImageReference } from "./types.ts";
import { imageInfo } from "./image-info.ts";

export function decodeImage(base64: string): Buffer {
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new Error("Invalid base64 image returned by Grok.");
  const bytes = Buffer.from(base64, "base64");
  imageInfo(bytes);
  return bytes;
}

export async function resolveImage(
  source: ImageSource,
  cwd: string,
  signal?: AbortSignal,
): Promise<ImageReference> {
  signal?.throwIfAborted();
  if (Number(source.path !== undefined) + Number(source.image_url !== undefined) !== 1)
    throw new Error("Each reference requires exactly one image source.");
  if (source.path !== undefined) {
    let path = source.path.replace(/^@/, "");
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    const bytes = await readFile(resolve(cwd, path), { signal });
    const info = imageInfo(bytes);
    return { type: "image_url", url: `data:${info.mimeType};base64,${bytes.toString("base64")}` };
  }
  const url = source.image_url!;
  if (url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(url);
    if (!match || imageInfo(decodeImage(match[2]!)).mimeType !== match[1])
      throw new Error("Reference must be a valid PNG/JPEG/WebP data URL.");
  } else if (!["https:", "http:"].includes(new URL(url).protocol)) {
    throw new Error("Reference URLs must use HTTP(S), or provide a local path.");
  }
  return { type: "image_url", url };
}

export interface SavedImage {
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}
export class ImageArtifactStore {
  constructor(private readonly root: string) {}
  async saveImage(sessionId: string, base64: string, signal?: AbortSignal): Promise<SavedImage> {
    signal?.throwIfAborted();
    const bytes = decodeImage(base64);
    const info = imageInfo(bytes);
    const parent = join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "ephemeral");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "call-"));
    try {
      const path = join(directory, `image-1.${info.extension}`);
      await writeFile(path, bytes, { flag: "wx", signal });
      return { path, mimeType: info.mimeType, bytes: bytes.length, width: info.width, height: info.height };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
