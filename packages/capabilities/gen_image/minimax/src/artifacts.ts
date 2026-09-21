import { open } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactDirectories } from "../../../../transports/minimax/src/artifacts.ts";
import { imageInfo } from "../../../gen_image/xai/src/image-info.ts";

export interface SavedImage {
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}
export class ImageArtifactStore extends ArtifactDirectories {
  async saveImage(sessionId: string, base64: string, signal?: AbortSignal): Promise<SavedImage> {
    signal?.throwIfAborted();
    if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
      throw new Error("Invalid base64 image returned by MiniMax.");
    const bytes = Buffer.from(base64, "base64");
    if (!bytes.length) throw new Error("MiniMax returned an empty image.");
    const info = imageInfo(bytes);
    const directory = await this.directory(sessionId);
    const path = join(directory, `image-1.${info.extension}`);
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes, { signal });
    } finally {
      await file.close();
    }
    return {
      path,
      mimeType: info.mimeType,
      bytes: bytes.length,
      width: info.width,
      height: info.height,
    };
  }
}
