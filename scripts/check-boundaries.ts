import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))
  ).flat();
}
const failures: string[] = [];
for (const dir of ["packages/core", "packages/capabilities", "packages/transports"]) {
  for (const file of await walk(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(file, "utf8");
    if (
      /from\s+["'][^"']*(?:@earendil-works\/pi-|hosts\/)/.test(text) ||
      /ExtensionContext|ExtensionAPI|ToolDefinition.*pi-coding-agent/.test(text)
    )
      failures.push(file);
  }
}
if (failures.length) throw new Error(`Host SDK leaked into base:\n${failures.join("\n")}`);
console.log("Dependency boundaries: core/capabilities/transports have no host SDK imports.");
