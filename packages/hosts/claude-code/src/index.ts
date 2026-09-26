import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enhanceHome } from "../../../core/src/config.ts";
import type { Catalog } from "../../../core/src/modules.ts";
import { distDirectory } from "./paths.ts";
import { serve } from "./server.ts";
import { hook } from "./hook.ts";
import { manage } from "./manage.ts";
import { pollXai } from "./login.ts";

const VERSION = "0.2.0";
/** Entry of dist/cc-enhance.mjs: `serve <capability>` | `hook prompt|stop` | `cli <args…>`. */
async function main(argv: string[]): Promise<void> {
  const home = enhanceHome();
  const dist = distDirectory();
  const catalog = JSON.parse(readFileSync(join(dist, "catalog.json"), "utf8")) as Catalog;
  const options = { home, catalog, moduleDirectory: join(dist, "modules") };
  const [command, ...rest] = argv;
  if (command === "serve") return serve(rest[0] ?? "", { ...options, version: VERSION });
  if (command === "hook") return hook(rest[0]);
  if (command === "poll-xai") return pollXai(home, rest[0] ?? "");
  if (command === "cli") {
    // Slash commands pass $ARGUMENTS as one string; split it here.
    const args = rest.flatMap((a) => a.split(/\s+/)).filter(Boolean);
    try {
      console.log(await manage(args, options));
    } catch (error) {
      console.log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  throw new Error("Usage: cc-enhance.mjs serve <capability> | hook <prompt|stop> | cli <args…>");
}
main(process.argv.slice(2)).catch((error: unknown) => {
  if (process.argv[2] === "hook") process.exit(0); // Never block Claude Code turns.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
