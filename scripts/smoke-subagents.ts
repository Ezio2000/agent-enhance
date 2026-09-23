// Explicit live-only probe. Three short, no-tool child Pi agents; may consume model quota.
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { Subagents } from "../packages/hosts/pi/src/subagents/index.ts";

if (!process.argv.includes("--live")) {
  console.log("Run: npx tsx scripts/smoke-subagents.ts --live (uses MiniMax, Kimi and GLM quotas)");
  process.exit(0);
}
const runtime = await ModelRuntime.create({ allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
const names = ["minimax-cn/MiniMax-M2.7", "kimi-coding/k3", "zai/glm-5.3-flash"];
const available = await runtime.getAvailable();
const selected = names.map((name) => {
  const model = available.find((item) => `${item.provider}/${item.id}` === name);
  if (!model) throw new Error(`Pi model is not available: ${name}`);
  return model;
});
let finish!: (text: string) => void;
const completed = new Promise<string>((resolve) => {
  finish = resolve;
});
const pi = {
  registerMessageRenderer() {},
  getActiveTools: () => ["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"],
  sendMessage(message: { content: string }) {
    finish(message.content);
  },
} as unknown as ExtensionAPI;
const subagents = new Subagents(pi, new CapabilityRegistry());
subagents.setEnabled(true);
subagents.startSession("live-probe");
const ctx = {
  cwd: process.cwd(),
  model: selected[0],
  thinkingLevel: "off",
  scopedModels: selected.map((model) => ({ model })),
  modelRegistry: registry,
  sessionManager: {
    getSessionId: () => "live-probe",
    getLeafId: () => "probe",
    getBranch: () => [{ id: "probe" }],
  },
  hasUI: false,
} as unknown as ExtensionContext;
try {
  const tool = subagents.tools().find((item) => item.name === "call_subagents")!;
  const result = await tool.execute(
    "probe",
    {
      tasks: selected.map((model) => ({
        context: "只回答：1=1 是否成立？用一句中文解释。不要调用任何工具。",
        model: `${model.provider}/${model.id}`,
        timeout_seconds: 120,
        max_turns: 2,
      })),
    },
    undefined,
    undefined,
    ctx,
  );
  console.log(result.content[0]);
  const text = await Promise.race([
    completed,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Live smoke timed out")), 180_000)),
  ]);
  console.log(text);
  if (text.includes("· failed") || text.includes("· timeout") || text.includes("· cancelled"))
    process.exitCode = 1;
} finally {
  subagents.shutdown();
}
