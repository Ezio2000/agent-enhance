import { build } from "esbuild";
import { readdir, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_VERSION, type Catalog } from "../packages/integrations/services/src/catalog.ts";
import type { CapabilityModule } from "../packages/core/src/contracts.ts";

const root = process.cwd();
await rm("dist/modules", { recursive: true, force: true });
await mkdir("dist/modules", { recursive: true });
const release = JSON.parse(await readFile("package.json", "utf8")).version as string;
const catalog: Catalog = { version: CATALOG_VERSION, release, modules: [] };
for (const capability of (await readdir("packages/capabilities")).sort()) {
  for (const provider of (await readdir(join("packages/capabilities", capability), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()) {
    const dir = join("packages/capabilities", capability, provider, "src");
    const module = (await import(join(root, dir, "index.ts"))).default as CapabilityModule;
    const file = `${capability}--${provider}.mjs`;
    await build({
      entryPoints: [join(dir, "index.ts")],
      outfile: join("dist/modules", file),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      legalComments: "inline",
    });
    catalog.modules.push({
      ...module.manifest,
      file,
      bytes: (await readFile(join("dist/modules", file))).length,
      label: module.definition.label,
      group: module.definition.group,
    });
  }
}
await writeFile("dist/catalog.json", JSON.stringify(catalog, null, 2) + "\n");
await build({
  entryPoints: ["packages/core/src/index.ts"],
  outfile: "dist/core.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
});
await build({
  entryPoints: ["packages/hosts/pi/src/index.ts"],
  outfile: "dist/pi-enhance.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox", "typebox/*"],
  banner: {
    js: 'import { createRequire as __piRequire } from "node:module"; const require = __piRequire(import.meta.url);',
  },
});
await build({
  entryPoints: ["packages/hosts/claude-code/src/index.ts"],
  outfile: "dist/cc-enhance.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "inline",
  banner: {
    js: 'import { createRequire as __ccRequire } from "node:module"; const require = __ccRequire(import.meta.url);',
  },
});
console.log(
  `Built Pi and Claude Code adapters with ${catalog.modules.length} bundled, lazily loaded capability modules.`,
);
