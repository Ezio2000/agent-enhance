import { readFile } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Catalog } from "../packages/core/src/modules.ts";
import { ConfigStore, enhanceHome } from "../packages/core/src/config.ts";
if (!process.argv.includes("--all")) {
  console.log(
    "Usage: npm run setup -- --all. Installs and saves all catalog modules through the INSTALLED Pi extension. Does not invoke cloud models.",
  );
  process.exit(0);
}
const settingsManager = SettingsManager.create(process.cwd());
const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  settingsManager,
  noContextFiles: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
});
await loader.reload();
if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
const { session } = await createAgentSession({
  resourceLoader: loader,
  settingsManager,
  modelRuntime,
  sessionManager: SessionManager.inMemory(),
});
try {
  await session.bindExtensions({ mode: "print" });
  const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8")) as Catalog;
  for (const entry of catalog.modules) {
    for (const action of ["install", "load --save"]) {
      await session.prompt(`/pi-enhance ${entry.provider} ${entry.capability} ${action}`);
      const last = session.messages.at(-1) as any;
      if (last?.role !== "custom" || !/^(Installed|Loaded)/.test(last.content))
        throw new Error(`Setup failed: ${String(last?.content)}`);
      console.log(last.content);
    }
  }
  const store = new ConfigStore(enhanceHome(), "pi");
  if (!store.load().defaults.gen_image) await session.prompt("/pi-enhance defaults gen_image openai");
  for (const entry of catalog.modules)
    if (!store.load().autoload.includes(entry.id)) throw new Error(`Not saved: ${entry.id}`);
  console.log("Active tools:", session.getActiveToolNames().join(", "));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
