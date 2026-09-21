import { mkdir, mkdtemp, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";

// Shared private directory allocation, mirroring the other transports.
export class ArtifactDirectories {
  constructor(private readonly root: string) {}
  protected async directory(sessionId: string): Promise<string> {
    const session = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "ephemeral";
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const parent = await realpath(this.root);
    const directory = join(parent, session);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink())
      throw new Error("Artifact session directory must not be a symlink.");
    return mkdtemp(join(directory, "call-"));
  }
}
