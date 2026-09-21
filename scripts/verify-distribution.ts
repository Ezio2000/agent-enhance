import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { ModuleManager, type Catalog } from "../packages/core/src/modules.ts";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";

if (!process.argv.includes("--download")) {
  console.log(
    "Usage: npm run verify:distribution -- --download. Downloads two public pinned capability bundles and tests the minimal tarball in an isolated Pi home. No model calls.",
  );
  process.exit(0);
}
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "enhance-distribution-"));
try {
  const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8")) as Catalog;
  const manager = new ModuleManager(join(root, "download"), catalog); // Deliberately no local module source.
  const registry = new CapabilityRegistry();
  for (const id of ["gen_image/openai", "gen_image/xai"]) {
    await manager.install(id);
    registry.load(await manager.load(id), { artifactRoot: join(root, "artifacts") });
  }
  assert.equal((await readdir(join(root, "download/packages"))).length, 2);
  assert.equal(registry.tools().length, 1);
  assert.deepEqual(registry.tools()[0]!.parameters.properties.provider.enum, ["openai", "xai"]);
  await registry.dispose();
  console.log("Immutable HTTPS download + SHA-256 + two-provider merge: PASS");
  const packed = await exec("npm", ["pack", "--json", "--pack-destination", root], {
    maxBuffer: 2 * 1024 * 1024,
  });
  const metadata = JSON.parse(packed.stdout)[0];
  assert.ok(!metadata.files.some((file: { path: string }) => file.path.startsWith("dist/modules/")));
  const unpack = join(root, "unpack");
  await mkdir(unpack);
  await exec("tar", ["-xzf", join(root, metadata.filename), "-C", unpack]);
  const extension = join(unpack, "package");
  const args = [
    "--no-extensions",
    "-e",
    join(extension, "dist/pi.mjs"),
    "--no-context-files",
    "--no-skills",
    "--no-session",
    "-p",
  ];
  const env = { ...process.env, AGENT_ENHANCE_HOME: join(root, "minimal-home"), PI_OFFLINE: "1" };
  const installProcess = exec("pi", [...args, "/pi-enhance openai gen_image install"], {
    env,
    timeout: 90_000,
  });
  installProcess.child.stdin?.end(); // Print mode consumes piped stdin before dispatching the prompt.
  const installed = await installProcess;
  assert.match(installed.stdout + installed.stderr, /Installed gen_image\/openai/);
  const loadProcess = exec("pi", [...args, "/pi-enhance openai gen_image load --save"], {
    env,
    timeout: 30_000,
  });
  loadProcess.child.stdin?.end();
  const loaded = await loadProcess;
  assert.match(loaded.stdout + loaded.stderr, /Loaded gen_image\/openai/);
  console.log(
    `Minimal tarball (${metadata.size} bytes), fresh Pi process, remote install and saved load: PASS`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
