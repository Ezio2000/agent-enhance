import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ToolDefinition as PiToolDefinition,
} from "@earendil-works/pi-coding-agent";
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type Model = NonNullable<ExtensionContext["model"]>;
import type { CapabilityRegistry } from "../../../../core/src/registry.ts";
import type { ExecutionContext } from "../../../../core/src/contracts.ts";
import { PiCredentialResolver } from "../auth.ts";
import { piHistory } from "../history.ts";

export interface SubagentTask {
  context: string;
  tools?: string[];
  model?: string;
  thinking_level?: ThinkingLevel;
  cwd?: string;
  timeout_seconds?: number;
  max_turns?: number;
}
export interface SubagentProgress {
  phase: "starting" | "thinking" | "tool";
  tool?: string;
  turns: number;
  usage: { input: number; output: number; cost: number };
  recent: Array<{ source: "assistant" | "tool"; tool?: string; text: string }>;
}
export interface SubagentOutcome {
  index: number;
  model: string;
  status: "completed" | "failed" | "cancelled" | "timeout" | "max_turns";
  text: string;
  turns: number;
  usage: { input: number; output: number; cost: number };
}

export async function runSubagent(
  task: SubagentTask,
  index: number,
  model: Model,
  thinkingLevel: ThinkingLevel,
  registry: CapabilityRegistry,
  parentRegistry: ExtensionContext["modelRegistry"],
  signal: AbortSignal,
  onProgress?: (progress: SubagentProgress) => void,
): Promise<SubagentOutcome> {
  const cwd = task.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  // Re-register Pi's active extension providers without scanning or copying credentials.
  for (const providerId of parentRegistry.getRegisteredProviderIds()) {
    const native = parentRegistry.getRegisteredNativeProvider(providerId);
    const config = parentRegistry.getRegisteredProviderConfig(providerId);
    if (native) modelRuntime.registerNativeProvider(native);
    else if (config) modelRuntime.registerProvider(providerId, config);
  }
  const requestedModel = modelRuntime.getModel(model.provider, model.id);
  if (!requestedModel)
    throw new Error(`Model ${model.provider}/${model.id} cannot be reconstructed in an isolated Pi session.`);

  const enhanced = new Map(registry.tools().map((tool) => [tool.name, tool]));
  const customTools: PiToolDefinition<any, any>[] = (task.tools ?? [])
    .filter((name) => enhanced.has(name))
    .map((name) => {
      const tool = enhanced.get(name)!;
      return {
        ...tool,
        execute: (id, args, toolSignal, update, ctx: ExtensionContext) => {
          const context: ExecutionContext = {
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            host: "pi",
            credentials: new PiCredentialResolver(ctx.modelRegistry),
            signal: toolSignal,
            model: ctx.model
              ? {
                  id: ctx.model.id,
                  provider: ctx.model.provider === "openai-codex" ? "openai" : ctx.model.provider,
                  channel: ctx.model.provider === "openai-codex" ? "codex" : undefined,
                  api: ctx.model.api === "openai-codex-responses" ? "codex-responses" : ctx.model.api,
                  input: ctx.model.input,
                }
              : undefined,
            history: piHistory(ctx.sessionManager.buildContextEntries()),
          };
          return tool.execute(id, args, toolSignal, update, context);
        },
      };
    });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: requestedModel,
    thinkingLevel,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: task.tools ?? [],
    customTools,
    excludeTools: ["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"],
  });
  let turns = 0;
  let limit: "cancelled" | "timeout" | "max_turns" | undefined;
  const usage = { input: 0, output: 0, cost: 0 };
  let phase: SubagentProgress["phase"] = "starting";
  let tool: string | undefined;
  const recent: SubagentProgress["recent"] = [];
  const report = () =>
    onProgress?.({ phase, tool, turns, usage: { ...usage }, recent: recent.map((entry) => ({ ...entry })) });
  const updateRecent = (source: "assistant" | "tool", text: string, name?: string, append = false) => {
    if (!text) return;
    const previous = recent.at(-1);
    if (append && previous?.source === source && previous.tool === name)
      previous.text = (previous.text + text).slice(-500);
    else {
      recent.push({ source, tool: name, text: text.slice(-500) });
      if (recent.length > 3) recent.shift();
    }
    report();
  };
  const toolText = (result: unknown): string => {
    if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
      return "";
    return result.content
      .filter(
        (item): item is { type: "text"; text: string } =>
          item?.type === "text" && typeof item.text === "string",
      )
      .map((item) => item.text.slice(-500))
      .join("\n")
      .slice(-500);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (reason: typeof limit) => {
    if (limit) return;
    limit = reason;
    void session.abort();
  };
  const onAbort = () => abort("cancelled");
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      if (task.max_turns && turns >= task.max_turns) abort("max_turns");
      else {
        phase = "thinking";
        tool = undefined;
        report();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      updateRecent("assistant", event.assistantMessageEvent.delta, undefined, true);
    if (event.type === "tool_execution_start") {
      phase = "tool";
      tool = event.toolName;
      report();
    }
    if (event.type === "tool_execution_update")
      updateRecent("tool", toolText(event.partialResult), event.toolName);
    if (event.type === "tool_execution_end") {
      updateRecent("tool", toolText(event.result), event.toolName);
      phase = "thinking";
      tool = undefined;
      report();
    }
    if (event.type === "turn_end") {
      turns++;
      report();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      usage.input += event.message.usage?.input ?? 0;
      usage.output += event.message.usage?.output ?? 0;
      usage.cost += event.message.usage?.cost?.total ?? 0;
      report();
    }
  });
  try {
    report();
    await session.bindExtensions({ mode: "print" });
    const actual = new Set(session.getActiveToolNames());
    for (const name of task.tools ?? [])
      if (!actual.has(name)) throw new Error(`Tool ${name} is unavailable in the child Pi session.`);
    if (signal.aborted) abort("cancelled");
    else signal.addEventListener("abort", onAbort, { once: true });
    if (task.timeout_seconds) timer = setTimeout(() => abort("timeout"), task.timeout_seconds * 1000);
    if (!limit) await session.prompt(task.context, { expandPromptTemplates: false });
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    const text = session.getLastAssistantText() || last?.errorMessage || "(no output)";
    return {
      index,
      model: `${model.provider}/${model.id}`,
      status:
        limit ?? (last?.stopReason === "error" || last?.stopReason === "aborted" ? "failed" : "completed"),
      text,
      turns,
      usage,
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}
