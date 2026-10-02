// Offline acceptance of an unpacked release with its own lazily imported modules.
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Catalog } from "../packages/integrations/services/src/catalog.ts";

const [extension, home] = process.argv.slice(2);
if (!extension || !home) throw new Error("Expected package and isolated home.");
process.env.AGENT_ENHANCE_HOME = home;
process.env.CODEX_HOME = join(home, "codex");
process.env.PI_CODING_AGENT_DIR = home;
process.env.XDG_DATA_HOME = join(home, "data");
process.env.OPENAI_CODEX_COMPUTER_APP = join(home, "absent.app");
for (const key of [
  "OPENCODE_AUTH_CONTENT",
  "OPENCODE_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MINIMAX_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
])
  delete process.env[key];
let network = 0;
globalThis.fetch = async (input) => {
  network++;
  throw new Error(`Unexpected network request: ${String(input)}`);
};
const catalog = JSON.parse(await readFile(join(extension, "dist/catalog.json"), "utf8")) as Catalog;
assert.equal((await readdir(join(extension, "dist/modules"))).length, catalog.modules.length);
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
await writeFile(
  join(home, "auth.json"),
  JSON.stringify({
    "openai-codex": { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600000 },
    xai: { type: "oauth", access: "fixture", refresh: "fixture", expires: Date.now() + 3600000 },
  }),
);
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
  assert.equal(session.getAllTools().filter((t) => t.name === "gen_image").length, 1);
  const image = session.getAllTools().find((t) => t.name === "gen_image")!;
  assert.deepEqual((image.parameters as any).properties.provider.enum, ["openai", "xai"]);
  await session.prompt("/pi-enhance services");
  await session.prompt("/pi-enhance prefer gen_image pi:xai");
  await session.prompt("/pi-enhance exclude gen_image pi:openai-codex");
  assert.deepEqual(
    (session.getAllTools().find((t) => t.name === "gen_image")!.parameters as any).properties.provider.enum,
    ["xai"],
  );
  await session.prompt("/pi-enhance exclude gen_image");
  assert.ok(!session.getActiveToolNames().includes("gen_image"));
  await session.prompt("/pi-enhance include gen_image");
  assert.ok(session.getActiveToolNames().includes("gen_image"));
  const preferences = JSON.parse(await readFile(join(home, "preferences/pi.json"), "utf8"));
  assert.equal(preferences.preferred.gen_image, "pi:xai");
  assert.deepEqual(preferences.excluded, ["gen_image@pi:openai-codex"]);
  assert.ok(!(await readdir(home)).includes("packages"));
  assert.ok(!(await readdir(home)).includes("modules.lock.json"));
  assert.equal(network, 0);
  assert.ok(!session.messages.some((m) => m.role === "assistant"));
  console.log(
    "Packed release: automatic discovery, merged providers, preference persistence, zero downloads/model calls. PASS",
  );
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
