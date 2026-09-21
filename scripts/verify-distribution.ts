import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--download"))
  throw new Error("Usage: npm run verify:distribution [-- --download]");
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "enhance-distribution-"));
try {
  const packed = await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const metadata = JSON.parse(packed.stdout)[0];
  const files: string[] = metadata.files.map((file: { path: string }) => file.path);
  for (const required of ["dist/pi.mjs", "dist/catalog.json", "package.json"])
    assert.ok(files.includes(required));
  assert.ok(
    !files.some(
      (file) =>
        file.startsWith("dist/modules/") ||
        file.startsWith("packages/") ||
        file.startsWith("node_modules/") ||
        file === "dist/core.mjs",
    ),
    "main package must not bundle capabilities, sources, or standalone core",
  );
  const unpack = join(root, "unpack"),
    home = join(root, "home");
  await mkdir(unpack);
  await mkdir(home);
  await exec("tar", ["-xzf", join(root, metadata.filename), "-C", unpack]);
  const probe = await exec(
    process.execPath,
    [
      "--import",
      "tsx",
      join(process.cwd(), "scripts/distribution-probe.ts"),
      join(unpack, "package"),
      home,
      join(process.cwd(), "dist/modules"),
      ...(args.includes("--download") ? ["--download"] : []),
    ],
    {
      env: { ...process.env, PI_OFFLINE: "1" },
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  console.log(probe.stdout);
  console.log(`Minimal tarball: ${metadata.size} bytes; no capability bundles included. PASS`);
} finally {
  await rm(root, { recursive: true, force: true });
}
