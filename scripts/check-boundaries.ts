import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))
  ).flat();
}
const failures: string[] = [];
for (const dir of [
  "packages/core",
  "packages/capabilities",
  "packages/transports",
  "packages/integrations",
]) {
  for (const file of await walk(dir)) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(file, "utf8");
    if (
      /from\s+["'][^"']*(?:@earendil-works\/pi-|hosts\/)/.test(source) ||
      /ExtensionContext|ExtensionAPI|ToolDefinition.*pi-coding-agent/.test(source)
    )
      failures.push(file);
    if (
      dir === "packages/core" &&
      (/from\s+["'][^"']*(?:integrations\/|transports\/|capabilities\/|node:fs|node:os)/.test(source) ||
        /process\.env|homedir\(/.test(source))
    )
      failures.push(file);
    if (dir === "packages/capabilities" && /from\s+["'][^"']*integrations\//.test(source))
      failures.push(file);
  }
}
for (const file of await walk("packages/hosts/claude-code")) {
  if (!file.endsWith(".ts")) continue;
  if (/from\s+["'][^"']*(?:@earendil-works\/pi-|hosts\/pi)/.test(await readFile(file, "utf8")))
    failures.push(file);
}
if (failures.length) throw new Error(`Dependency boundary violations:\n${[...new Set(failures)].join("\n")}`);
console.log(
  "Boundaries: Core has no discovery/configuration sources; services/capabilities/transports have no host SDK imports.",
);
