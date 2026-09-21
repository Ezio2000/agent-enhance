import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface SavedVideo {
  path: string;
  mimeType: "video/mp4";
  bytes: number;
}

export class VideoArtifactStore {
  constructor(private readonly root: string) {}

  async saveVideo(sessionId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<SavedVideo> {
    signal?.throwIfAborted();
    if (!bytes.length) throw new Error("Grok returned no video data. No file was saved.");
    const parent = join(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, "_") || "ephemeral");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "call-"));
    try {
      const path = join(directory, "video-1.mp4");
      await writeFile(path, bytes, { flag: "wx", signal });
      return { path, mimeType: "video/mp4", bytes: bytes.length };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
