import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resizeImage, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import { StaticCredentialResolver } from "../../../core/src/auth.ts";
import { transformControlledRequest } from "../../../core/src/controls.ts";
import type { ExecutionContext, ModelInfo, ToolDefinition, ToolResult } from "../../../core/src/contracts.ts";
import {
  PreferenceStore,
  enhanceHome,
  emptyPiPreferences,
  type PiPreferences,
} from "../../../integrations/services/src/preferences.ts";
import { ModuleCatalog, type Catalog } from "../../../integrations/services/src/catalog.ts";
import { ServiceRuntime } from "../../../integrations/services/src/runtime.ts";
import type { ServiceSource } from "../../../integrations/services/src/contracts.ts";
import { fileSources, sourcePaths } from "../../../integrations/services/src/sources/files.ts";
import { watchServiceSources } from "../../../integrations/services/src/watch.ts";
import { piServiceSource, piSourcePaths } from "./auth.ts";
import { piHistory } from "./history.ts";
import { installEnhanceFooter, type FooterLabel } from "./footer.ts";
import { registerManagement } from "./management.ts";
import { requestControls, verifyRequestPreferences } from "./requests/index.ts";
import { Subagents } from "./subagents/index.ts";
const command = "pi-enhance";
const releaseGuidance =
  "When changing agent-enhance/pi-enhance for installation in Pi, follow the repository's docs/release.md: run checks, commit and push to https://github.com/Ezio2000/agent-enhance, then install or update Pi from that Git remote. Never persistently install the local working tree. If pushing is not authorized or fails, ask or stop rather than substituting a local installation.";
const support = new Set(["approval", "task-settled", "request-interception"]);
export function modelInfo(model: ExtensionContext["model"]): ModelInfo | undefined {
  if (!model) return;
  return {
    id: model.id,
    provider: model.provider === "openai-codex" ? "openai" : model.provider,
    channel: model.provider === "openai-codex" ? "codex" : undefined,
    api: model.api === "openai-codex-responses" ? "codex-responses" : model.api,
    input: model.input,
  };
}
export function executionContext(ctx: ExtensionContext): ExecutionContext {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    host: "pi",
    model: modelInfo(ctx.model),
    credentials: new StaticCredentialResolver({}),
    signal: ctx.signal,
    history: piHistory(ctx.sessionManager.buildContextEntries()),
    choose: ctx.hasUI ? (title, choices, signal) => ctx.ui.select(title, choices, { signal }) : undefined,
  };
}
export interface PiOptions {
  home: string;
  catalog: Catalog;
  moduleDirectory: string;
  sources?(ctx: ExtensionContext): readonly ServiceSource[];
}
export function createPiEnhance(pi: ExtensionAPI, options: PiOptions): void {
  const store = new PreferenceStore(options.home, "pi", emptyPiPreferences, verifyRequestPreferences);
  let preferences = store.load();
  const registry = new CapabilityRegistry();
  const modules = new ModuleCatalog(options.catalog, options.moduleDirectory);
  const runtimeOptions = {
    modules,
    registry,
    services: (entry: Catalog["modules"][number]) => ({
      artifactRoot: join(options.home, "artifacts", "pi", entry.capability, entry.provider),
      preview: (bytes: Uint8Array, mime: string) =>
        resizeImage(bytes, mime, { maxWidth: 1024, maxHeight: 1024, maxBytes: 512 * 1024 }),
    }),
  };
  let runtime = new ServiceRuntime(runtimeOptions);
  const subagents = new Subagents(pi, registry);
  let previousProvider: string | undefined;
  let disposed = false,
    operations = new AbortController();
  let registered = new Set<string>();
  const knownNames = new Set<string>();
  let footerLabels: readonly FooterLabel[] = [];
  let currentContext: ExtensionContext | undefined, stopWatching: (() => void) | undefined;
  const sourceOptions = { home: options.home, nativePi: true };
  const sources = (ctx: ExtensionContext) =>
    options.sources?.(ctx) ?? [piServiceSource(ctx), ...fileSources(sourceOptions)];
  const report = (ctx: ExtensionContext, text: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
    else {
      pi.sendMessage({ customType: "pi-enhance", content: text, display: true }, { triggerTurn: false });
      if (ctx.mode === "print") console.log(text);
    }
  };
  const statusLine = (ctx: ExtensionContext) => {
    const model = modelInfo(ctx.model);
    footerLabels =
      model?.provider === "openai" && model.channel === "codex" && model.api === "codex-responses"
        ? requestControls
            .filter((control) => control.supported(model))
            .map((control) => {
              const value = preferences.requests[control.id] ?? "off";
              return {
                id: control.id,
                value: control.formatValue?.(value, model) ?? value,
                active: value !== "off",
              };
            })
        : [];
    if (ctx.hasUI)
      ctx.ui.setStatus(
        command,
        footerLabels.length ? footerLabels.map((l) => `${l.id}:${l.value}`).join(" ") : undefined,
      );
  };
  const executeTool = async (
    tool: ToolDefinition<any, any>,
    id: string,
    args: any,
    signal: AbortSignal | undefined,
    update: ((result: ToolResult<any>) => void) | undefined,
    ctx: ExtensionContext,
  ) => {
    try {
      return await tool.execute(id, args, signal, update, executionContext(ctx));
    } finally {
      scheduleSynchronization();
    }
  };
  const refresh = (ctx: ExtensionContext) => {
    const hostTools = subagents.tools();
    const tools = [...registry.tools(), ...hostTools];
    const active = new Set(pi.getActiveTools());
    for (const tool of tools) {
      const collision = pi.getAllTools().find((t) => t.name === tool.name);
      if (collision && !knownNames.has(tool.name))
        throw new Error(`Tool collision: ${tool.name}; disable the conflicting extension first.`);
      const hostTool = hostTools.find((candidate) => candidate.name === tool.name);
      if (hostTool) pi.registerTool(hostTool);
      else {
        const capabilityTool = tool as ReturnType<CapabilityRegistry["tools"]>[number];
        pi.registerTool({
          ...capabilityTool,
          execute: (id, args, signal, update, piContext) =>
            executeTool(capabilityTool, id, args, signal, update, piContext),
        });
      }
      if (!registered.has(tool.name)) active.add(tool.name);
    }
    const available = new Set(tools.map((t) => t.name));
    for (const name of registered) if (!available.has(name)) active.delete(name);
    registered = available;
    for (const name of available) knownNames.add(name);
    pi.setActiveTools([...active]);
    statusLine(ctx);
  };
  const scheduleSynchronization = () => {
    const ctx = currentContext;
    if (!disposed && ctx)
      void synchronize(ctx).catch((error) => {
        if (!disposed && currentContext === ctx) report(ctx, String(error), true);
      });
  };
  const synchronize = async (ctx: ExtensionContext) => {
    if (disposed) return;
    currentContext = ctx;
    preferences = store.load();
    subagents.setEnabled(preferences.subagents.enabled);
    subagents.setDefaultModel(preferences.subagents.model);
    await runtime.synchronize(
      sources(ctx),
      preferences,
      { features: support, model: modelInfo(ctx.model) },
      operations.signal,
    );
    if (!disposed && ctx === currentContext) refresh(ctx);
  };
  registerManagement(pi, {
    runtime: () => runtime,
    store,
    preferences: () => preferences,
    subagents,
    synchronize,
    refresh,
    report,
    signal: () => operations.signal,
  });
  pi.on("session_start", async (_event, ctx) => {
    if (disposed) {
      operations = new AbortController();
      runtime = new ServiceRuntime(runtimeOptions);
    }
    disposed = false;
    previousProvider = ctx.model?.provider;
    preferences = store.load();
    subagents.setEnabled(preferences.subagents.enabled);
    subagents.setDefaultModel(preferences.subagents.model);
    subagents.startSession(ctx.sessionManager.getSessionId());
    await synchronize(ctx);
    stopWatching?.();
    stopWatching = watchServiceSources(
      [store.path, ...sourcePaths(sourceOptions), ...piSourcePaths()],
      scheduleSynchronization,
    );
    installEnhanceFooter(ctx, command, () => footerLabels);
  });
  pi.on("model_select", async (event, ctx) => {
    const model = (event.model ?? ctx.model) as ExtensionContext["model"];
    if (previousProvider !== undefined && model?.provider !== previousProvider)
      await registry.lifecycle("provider_change");
    previousProvider = model?.provider;
    await synchronize({ ...ctx, model });
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (disposed) return;
    const payload = transformControlledRequest(
      event.payload,
      modelInfo(ctx.model),
      requestControls,
      preferences.requests,
    );
    if (payload !== event.payload) return payload;
  });
  pi.on("before_agent_start", async (event, ctx) => {
    event.systemPromptOptions.sections.pi_enhance_release = releaseGuidance;
    await synchronize(ctx);
    const notices = registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    if (notices.length)
      return { message: { customType: "pi-enhance:recovery", content: notices.join("\n"), display: false } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await registry.lifecycle("task_settled", () => ctx.isIdle());
    await synchronize(ctx);
  });
  pi.on("session_tree", async () => {
    subagents.cancelAll();
    await registry.lifecycle("session_tree");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    stopWatching?.();
    currentContext = undefined;
    subagents.shutdown();
    operations.abort();
    try {
      await runtime.dispose();
    } finally {
      if (ctx.hasUI) {
        ctx.ui.setStatus(command, undefined);
        ctx.ui.setFooter(undefined);
      }
    }
  });
}
export default function piEnhance(pi: ExtensionAPI): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = existsSync(join(here, "catalog.json")) ? here : join(here, "../../../../dist");
  const catalog = JSON.parse(readFileSync(join(dist, "catalog.json"), "utf8")) as Catalog;
  createPiEnhance(pi, { home: enhanceHome(), catalog, moduleDirectory: join(dist, "modules") });
}
