import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("real Pi SDK loads built adapter, executes commands, refreshes schemas and preserves excluded tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-sdk-"));
  const oldHome = process.env.AGENT_ENHANCE_HOME;
  process.env.AGENT_ENHANCE_HOME = home;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({
      packages: [],
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: home,
      agentDir: home,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      additionalExtensionPaths: [join(process.cwd(), "dist/pi.mjs")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(home, "auth.json"),
      modelsPath: join(home, "models.json"),
      modelsStorePath: join(home, "models-store.json"),
      allowModelNetwork: false,
    });
    const result = await createAgentSession({
      cwd: home,
      agentDir: home,
      settingsManager,
      resourceLoader: loader,
      modelRuntime,
      sessionManager: SessionManager.inMemory(home),
      excludeTools: ["gen_video"],
    });
    session = result.session;
    await session.bindExtensions({
      mode: "print",
      onError: (e) => {
        throw new Error(String(e));
      },
    });
    await session.prompt("/pi-enhance openai gen_image install");
    await session.prompt("/pi-enhance openai gen_image load --save");
    await session.prompt("/pi-enhance xai gen_image install");
    await session.prompt("/pi-enhance xai gen_image load");
    const image = session.getAllTools().find((t) => t.name === "gen_image");
    assert.ok(image, JSON.stringify(session.messages));
    assert.deepEqual((image.parameters as any).properties.provider.enum, ["openai", "xai"]);
    assert.equal(session.getAllTools().filter((t) => t.name === "gen_image").length, 1);
    assert.ok(session.getActiveToolNames().includes("gen_image"));
    await session.prompt("/pi-enhance xai gen_video install");
    await session.prompt("/pi-enhance xai gen_video load");
    assert.ok(
      !session.getActiveToolNames().includes("gen_video"),
      "host exclusions must not be bypassed by dynamic activation",
    );
    await session.prompt("/pi-enhance openai gen_image unload --save");
    assert.deepEqual(
      (session.getAllTools().find((t) => t.name === "gen_image")!.parameters as any).properties.provider.enum,
      ["xai"],
    );
    await session.prompt("/pi-enhance xai gen_image unload");
    assert.ok(!session.getActiveToolNames().includes("gen_image"));
    assert.ok(!session.messages.some((m) => m.role === "assistant")); // Commands never invoke a model.
  } finally {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    if (oldHome === undefined) delete process.env.AGENT_ENHANCE_HOME;
    else process.env.AGENT_ENHANCE_HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
