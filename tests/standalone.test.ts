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

test("native computer bundle embeds its runtime and runs without the checkout or node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "enhance-native-standalone-"));
  try {
    await copyFile("dist/modules/use_computer--native.mjs", join(root, "computer.mjs"));
    await writeFile(
      join(root, "test.mjs"),
      `
      import module from './computer.mjs';
      import assert from 'node:assert/strict';
      const instance = module.create({artifactRoot:'./artifacts',runtimeRoot:'./runtimes'});
      assert.equal(module.manifest.id,'use_computer/native');
      assert.equal(module.manifest.auth,undefined);
      assert.equal(instance.status().connected,false);
      assert.equal(instance.status().permissions,'not_checked');
      if(process.platform==='darwin') {
        const result=await instance.tool.execute('read',{code:'await computer.getState()',timeout_seconds:15},undefined,undefined,{sessionId:'standalone'});
        assert.match(result.content[0].text,/"?accessibility"?/);
        assert.equal(instance.status().connected,true);
        await instance.lifecycle('task_settled',()=>true);
        assert.equal(instance.status().lastCleanup.nativeStopped,true);
        assert.equal(instance.status().lastCleanup.workerStopped,true);
      }
      await instance.dispose();
      console.log('native-standalone-ok');
    `,
    );
    const result = await promisify(execFile)(process.execPath, [join(root, "test.mjs")], {
      cwd: root,
      env: { PATH: process.env.PATH, OPENAI_CODEX_COMPUTER_APP: "/does-not-exist/ChatGPT.app" },
      timeout: 20000,
    });
    assert.match(result.stdout, /native-standalone-ok/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
