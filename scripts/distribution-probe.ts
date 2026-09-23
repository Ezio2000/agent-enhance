// Runs in a fresh process with an unpacked minimal package and an empty host home.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Catalog } from "../packages/core/src/modules.ts";

const [extension, home, source, mode] = process.argv.slice(2);
if (!extension || !home || !source) throw new Error("Expected package, home and fixture source paths.");
process.env.AGENT_ENHANCE_HOME = home;
const catalog = JSON.parse(await readFile(join(extension, "dist/catalog.json"), "utf8")) as Catalog;
const requested: string[] = [];
const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const prefix = `https://raw.githubusercontent.com/${catalog.repository}/${catalog.revision}/dist/modules/`;
  assert.ok(url.startsWith(prefix), `Unexpected network operation: ${url}`);
  assert.equal(init?.redirect, "error");
  assert.equal(init?.headers, undefined, "module downloads must not carry credentials");
  const file = url.slice(prefix.length);
  assert.ok(
    catalog.modules.some((e) => e.file === file),
    `Unexpected module: ${file}`,
  );
  requested.push(file);
  return mode === "--download" ? networkFetch(input, init) : new Response(await readFile(join(source, file)));
};
const settingsManager = SettingsManager.inMemory({
  packages: [],
  compaction: { enabled: false },
  retry: { enabled: false },
});
const resourceLoader = new DefaultResourceLoader({
  cwd: home,
  agentDir: home,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noPromptTemplates: true,
  noContextFiles: true,
  additionalExtensionPaths: [join(extension, "dist/pi-enhance.mjs")],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const modelRuntime = await ModelRuntime.create({
  authPath: join(home, "auth.json"),
  modelsPath: join(home, "models.json"),
  modelsStorePath: join(home, "models-store.json"),
  allowModelNetwork: false,
});
const { session } = await createAgentSession({
  cwd: home,
  agentDir: home,
  settingsManager,
  resourceLoader,
  modelRuntime,
  sessionManager: SessionManager.inMemory(home),
});
try {
  await session.bindExtensions({
    mode: "print",
    onError: (error) => {
      throw new Error(String(error));
    },
  });
  assert.equal(
    session.getAllTools().filter((t) => catalog.modules.some((e) => e.capability === t.name)).length,
    0,
  );
  assert.deepEqual(requested, [], "fresh startup must not download capabilities");
  await session.prompt("/pi-enhance catalog");
  assert.deepEqual(requested, [], "browsing metadata must not download capabilities");
  await session.prompt("/pi-enhance openai gen_image enable");
  assert.deepEqual(requested, ["gen_image--openai.mjs"]);
  assert.equal((await readdir(join(home, "packages"))).length, 1);
  assert.ok(session.getActiveToolNames().includes("gen_image"));
  await session.prompt("/pi-enhance openai gen_image enable");
  await session.prompt("/pi-enhance update --installed");
  assert.equal(requested.length, 1, "repeated enable/update must not redownload current modules");
  await session.prompt("/pi-enhance xai gen_image enable");
  const image = session.getAllTools().filter((t) => t.name === "gen_image");
  assert.equal(image.length, 1);
  assert.deepEqual((image[0]!.parameters as any).properties.provider.enum, ["openai", "xai"]);
  assert.deepEqual(requested, ["gen_image--openai.mjs", "gen_image--xai.mjs"]);
  await session.prompt("/pi-enhance openai gen_image disable");
  assert.deepEqual(
    (session.getAllTools().find((t) => t.name === "gen_image")!.parameters as any).properties.provider.enum,
    ["xai"],
  );
  await session.prompt("/pi-enhance xai gen_image disable");
  assert.ok(!session.getActiveToolNames().includes("gen_image"));
  await session.prompt("/pi-enhance openai gen_image uninstall");
  const config = JSON.parse(await readFile(join(home, "hosts/pi.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(home, "modules.lock.json"), "utf8"));
  assert.deepEqual(config.autoload, []);
  assert.deepEqual(Object.keys(lock.modules), ["gen_image/xai"]);
  assert.equal((await readdir(join(home, "packages"))).length, 2, "uninstall retains content cache");
  assert.ok(!session.messages.some((m) => m.role === "assistant"), "management must not invoke any model");
  console.log(
    `Minimal package, zero-capability startup, selective ${mode === "--download" ? "HTTPS" : "mocked HTTPS"} download, enable/disable/update: PASS`,
  );
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
  globalThis.fetch = networkFetch;
}
