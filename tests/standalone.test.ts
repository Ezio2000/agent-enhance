import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("standalone base and two provider bundles work in a clean directory without Pi or node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-standalone-"));
  try {
    await copyFile("dist/core.mjs", join(root, "core.mjs"));
    await copyFile("dist/modules/gen_image--openai.mjs", join(root, "openai.mjs"));
    await copyFile("dist/modules/gen_image--xai.mjs", join(root, "xai.mjs"));
    await writeFile(
      join(root, "test.mjs"),
      `
      import { CapabilityRegistry, StaticCredentialResolver } from './core.mjs';
      import openai from './openai.mjs'; import xai from './xai.mjs';
      const registry = new CapabilityRegistry();
      registry.load(openai, {artifactRoot: './artifacts'});
      registry.load(xai, {artifactRoot: './artifacts'});
      const tools = registry.tools();
      if (tools.length !== 1 || tools[0].name !== 'gen_image') throw new Error('Not merged');
      if (tools[0].parameters.properties.provider.enum.length !== 2) throw new Error('Missing provider');
      await registry.dispose();
      console.log('standalone-ok');
    `,
    );
    const result = await promisify(execFile)(process.execPath, [join(root, "test.mjs")], {
      cwd: root,
      env: { PATH: process.env.PATH },
      timeout: 10_000,
    });
    assert.match(result.stdout, /standalone-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
