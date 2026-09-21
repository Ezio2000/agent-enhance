import { open } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactDirectories } from "../../../../transports/minimax/src/artifacts.ts";

export interface SavedVoice {
  path: string;
  mimeType: "audio/mpeg";
  bytes: number;
}
export class VoiceArtifactStore extends ArtifactDirectories {
  async saveVoice(sessionId: string, bytes: Buffer, signal?: AbortSignal): Promise<SavedVoice> {
    signal?.throwIfAborted();
    if (!bytes.length) throw new Error("MiniMax returned no audio data. No file was saved.");
    const directory = await this.directory(sessionId);
    const path = join(directory, "voice-1.mp3");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes, { signal });
    } finally {
      await file.close();
    }
    return { path, mimeType: "audio/mpeg", bytes: bytes.length };
  }
}
