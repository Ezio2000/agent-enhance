// Explicit live-only Pi SDK parent + built extension + background child integration probe.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

if (!process.argv.includes("--live")) {
  console.log(
    "Run: npx tsx scripts/smoke-subagent-host.ts --live (uses MiniMax child and one parent follow-up)",
  );
  process.exit(0);
}
const home = await mkdtemp(join(tmpdir(), "enhance-host-child-"));
const previous = process.env.AGENT_ENHANCE_HOME;
process.env.AGENT_ENHANCE_HOME = home;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  const settingsManager = SettingsManager.inMemory({ packages: [], retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: home,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(process.cwd(), "dist/pi-enhance.mjs")],
    extensionFactories: [
      (pi: ExtensionAPI) => {
        pi.registerCommand("probe-subagents", {
          description: "Live integration probe",
          handler: async (_args, ctx) => {
            const tool = session?.getToolDefinition("call_subagents");
            if (!tool) throw new Error("call_subagents not active");
            const result = await tool.execute(
              "probe",
              { tasks: [{ context: "只回答 1=1 是否成立，一句话。", model: "minimax-cn/MiniMax-M2.7" }] },
              undefined,
              undefined,
              ctx,
            );
            console.log("Dispatch:", result.content);
          },
        });
      },
    ],
  });
  await loader.reload();
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const model = runtime.getModel("minimax-cn", "MiniMax-M2.7");
  if (!model) throw new Error("MiniMax model unavailable");
  session = (
    await createAgentSession({
      cwd: home,
      agentDir: getAgentDir(),
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(home),
    })
  ).session;
  await session.bindExtensions({ mode: "print" });
  await session.prompt("/pi-enhance subagents enable");
  await session.prompt("/probe-subagents");
  const start = Date.now();
  while (Date.now() - start < 120_000) {
    const message = session.messages.find(
      (m) => m.role === "custom" && m.customType === "pi-enhance:subagents",
    );
    if (message?.role === "custom") {
      console.log("Completion:", message.content);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!session.messages.some((m) => m.role === "custom" && m.customType === "pi-enhance:subagents"))
    throw new Error("No completion delivered to the parent Pi SDK session");
} finally {
  if (session) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  if (previous === undefined) delete process.env.AGENT_ENHANCE_HOME;
  else process.env.AGENT_ENHANCE_HOME = previous;
  await rm(home, { recursive: true, force: true });
}
