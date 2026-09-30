import { build } from "esbuild";
import { readdir, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Catalog } from "../packages/core/src/modules.ts";
import { gunzipSync } from "node:zlib";
import { nativeSourceHash } from "./build-computer-native.ts";
import { computerCertificateSha1, computerRequirement } from "./computer-signing.ts";
const root = process.cwd();
const nativePayload = await readFile("dist/native/computer-runtime.json.gz");
const nativeArchive = JSON.parse(gunzipSync(nativePayload).toString());
if (nativeArchive.sourceHash !== (await nativeSourceHash()))
  throw new Error(
    "Native runtime sources changed. Run npm run build:computer-native on macOS before building modules.",
  );
if (
  nativeArchive.signing?.type !== "self-signed" ||
  nativeArchive.signing.certificateSha1 !== computerCertificateSha1 ||
  nativeArchive.signing.requirement !== computerRequirement(computerCertificateSha1)
)
  throw new Error("Native payload does not carry the published fixed signing identity.");
await mkdir("dist/modules", { recursive: true });
let revision = process.env.MODULE_REVISION ?? "development";
try {
  if (!process.env.MODULE_REVISION)
    revision = JSON.parse(await readFile("dist/catalog.json", "utf8")).revision;
} catch {
  /* first build */
}
const catalog: Catalog = { version: 1, revision, repository: "Ezio2000/agent-enhance", modules: [] };
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
      plugins: [
        {
          name: "embedded-native-runtime",
          setup(builder) {
            builder.onLoad({ filter: /use_computer\/native\/src\/payload\.ts$/ }, () => ({
              contents: `export async function nativePayload() { return Buffer.from(${JSON.stringify(nativePayload.toString("base64"))}, "base64"); }`,
              loader: "js",
            }));
          },
        },
      ],
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
  outfile: "dist/pi-enhance.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
});
// Claude Code host: fully self-contained (MCP SDK included), run from the plugin checkout with plain node.
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
  `Built Pi and Claude Code adapters and ${catalog.modules.length} independently installable, integrity-pinned modules.`,
);
