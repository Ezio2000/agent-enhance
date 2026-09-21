import { build } from "esbuild";
import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Catalog } from "../packages/core/src/modules.ts";
const root = process.cwd();
await mkdir("dist/modules", { recursive: true });
let revision = process.env.MODULE_REVISION ?? "development";
try {
  if (!process.env.MODULE_REVISION)
    revision = JSON.parse(await readFile("dist/catalog.json", "utf8")).revision;
} catch {
  /* first build */
}
const catalog: Catalog = { version: 1, revision, repository: "Ezio2000/openai-codex-enhance", modules: [] };
for (const capability of (await readdir("packages/capabilities")).sort()) {
  for (const provider of (await readdir(join("packages/capabilities", capability))).sort()) {
    const dir = join("packages/capabilities", capability, provider, "src");
    const { manifest } = await import(join(root, dir, "manifest.ts"));
    const file = `${capability}--${provider}.mjs`;
    await build({
      entryPoints: [join(dir, "index.ts")],
      outfile: join("dist/modules", file),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      minify: false,
      legalComments: "inline",
    });
    const bytes = await readFile(join("dist/modules", file));
    catalog.modules.push({
      ...manifest,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
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
  outfile: "dist/pi.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
console.log(
  `Built Pi adapter and ${catalog.modules.length} independently installable, integrity-pinned modules.`,
);
