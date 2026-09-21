import { open } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactDirectories } from "../../../../transports/openai/src/artifacts.ts";

export { truncateText } from "../../../../transports/openai/src/output.ts";

export class WebOutputStore extends ArtifactDirectories {
  async saveText(sessionId: string, text: string): Promise<string> {
    const directory = await this.directory(sessionId);
    const path = join(directory, "search.txt");
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
    } finally {
      await file.close();
    }
    return path;
  }
}
