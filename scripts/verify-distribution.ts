import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

if (process.argv.length > 2) throw new Error("Usage: npm run verify:distribution");
const exec = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), "enhance-distribution-"));
try {
  const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const metadata = JSON.parse(packed.stdout)[0],
    files: string[] = metadata.files.map((file: { path: string }) => file.path);
  const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8"));
  for (const required of [
    "dist/pi-enhance.mjs",
    "dist/catalog.json",
    "package.json",
    ...catalog.modules.map((m: { file: string }) => `dist/modules/${m.file}`),
  ])
    assert.ok(files.includes(required), required);
  assert.ok(
    !files.some(
      (file) => file.startsWith("packages/") || file.startsWith("node_modules/") || file === "dist/core.mjs",
    ),
  );
  const unpack = join(root, "unpack"),
    home = join(root, "home");
  await mkdir(unpack);
  await mkdir(home);
  await exec("tar", ["-xzf", join(root, metadata.filename), "-C", unpack]);
  const probe = await exec(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "scripts/distribution-probe.ts"), join(unpack, "package"), home],
    { env: { ...process.env, PI_OFFLINE: "1" }, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  console.log(probe.stdout);
  console.log(`Release tarball: ${metadata.size} bytes; all capability modules included. PASS`);
} finally {
  await rm(root, { recursive: true, force: true });
}
