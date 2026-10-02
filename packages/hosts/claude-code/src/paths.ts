import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_ID = "claude-code";
/** MCP server key in the plugin config; Claude Code shows it as `plugin:cc-enhance:x`. */
export const SERVER_NAME = "x";
/** Directory holding catalog.json and modules/ (the bundle's own dist, or the repository dist in development). */
export function distDirectory(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return existsSync(join(here, "catalog.json")) ? here : join(here, "../../../../dist");
}
/** Unix socket paths are length-limited (104 bytes on macOS), so runtime state lives under the temp dir. */
export function runDirectory(): string {
  return process.env.CC_ENHANCE_RUN_DIR ?? join(tmpdir(), `cc-enhance-${userInfo().uid}`);
}
export const artifactRoot = (home: string, capability: string, provider: string) =>
  join(home, "artifacts", HOST_ID, capability, provider);
