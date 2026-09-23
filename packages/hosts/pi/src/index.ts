import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resizeImage, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import { ConfigStore, enhanceHome } from "../../../core/src/config.ts";
import { ModuleManager, type Catalog } from "../../../core/src/modules.ts";
import { transformControlledRequest } from "../../../core/src/controls.ts";
import type { CapabilityModule, ExecutionContext, ModelInfo } from "../../../core/src/contracts.ts";
import { PiCredentialResolver } from "./auth.ts";
import { piHistory } from "./history.ts";
import { installEnhanceFooter, type FooterLabel } from "./footer.ts";
import { registerManagement } from "./management.ts";
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
    credentials: new PiCredentialResolver(ctx.modelRegistry),
    signal: ctx.signal,
    history: piHistory(ctx.sessionManager.buildContextEntries()),
    choose: ctx.hasUI ? (title, choices, signal) => ctx.ui.select(title, choices, { signal }) : undefined,
  };
}
export interface PiOptions {
  home: string;
  catalog: Catalog;
  moduleDirectory?: string;
}
export function createPiEnhance(pi: ExtensionAPI, options: PiOptions): void {
  const store = new ConfigStore(options.home, "pi");
  let config = store.load();
  const registry = new CapabilityRegistry(config.defaults);
  const manager = new ModuleManager(options.home, options.catalog, options.moduleDirectory);
  const subagents = new Subagents(pi, registry);
  subagents.setEnabled(config.subagents === true);
  let previousProvider: string | undefined;
  let disposed = false;
  let operations = new AbortController();
  let registered = new Set<string>();
  const knownNames = new Set<string>();
  let footerLabels: readonly FooterLabel[] = [];
  const report = (ctx: ExtensionContext, text: string, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
    else {
      pi.sendMessage({ customType: "pi-enhance", content: text, display: true }, { triggerTurn: false });
      if (ctx.mode === "print") console.log(text);
    }
  };
  const statusLine = (ctx: ExtensionContext) => {
    const model = modelInfo(ctx.model);
    footerLabels = registry
      .list()
      .filter((e) => {
        const control = e.instance.control;
        return (
          control &&
          model?.provider === "openai" &&
          model.channel === "codex" &&
          model.api === "codex-responses" &&
          control.supported(model)
        );
      })
      .map((e): FooterLabel => {
        const control = e.instance.control!,
          value = config.controls[control.id] ?? "off";
        return {
          id: control.id,
          value: control.formatValue ? control.formatValue(value, model!) : value,
          active: value !== "off",
        };
      });
    if (ctx.hasUI)
      ctx.ui.setStatus(
        command,
        footerLabels.length ? footerLabels.map((l) => `${l.id}:${l.value}`).join(" ") : undefined,
      );
  };
  /** Tools whose manifest excludes them for the active model's input modalities stay unregistered. */
  const excludedCapabilities = (ctx: ExtensionContext): Set<string> => {
    const input = modelInfo(ctx.model)?.input;
    if (!input?.length) return new Set();
    return new Set(
      registry
        .list()
        .filter(
          (e) =>
            e.instance.tool &&
            e.module.manifest.modelInputExcludes?.some((modality) => input.includes(modality)),
        )
        .map((e) => e.module.manifest.capability),
    );
  };
  const refresh = (ctx: ExtensionContext) => {
    const excluded = excludedCapabilities(ctx);
    const hostTools = subagents.tools();
    const tools = [...registry.tools().filter((tool) => !excluded.has(tool.name)), ...hostTools];
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
            capabilityTool.execute(id, args, signal, update, executionContext(piContext)),
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
  const synchronize = refresh;
  const activate = async (module: CapabilityModule, ctx: ExtensionContext) => {
    const manifest = module.manifest,
      id = manifest.id;
    registry.load(module, {
      artifactRoot: join(options.home, "artifacts", "pi", manifest.capability, manifest.provider),
      preview: (bytes, mime) =>
        resizeImage(bytes, mime, { maxWidth: 1024, maxHeight: 1024, maxBytes: 512 * 1024 }),
    });
    try {
      synchronize(ctx);
      if (manifest.modelInputExcludes?.length)
        report(
          ctx,
          `${id}: registered only while the active model lacks ${manifest.modelInputExcludes.join("/")} input.`,
        );
    } catch (error) {
      await registry.unload(id);
      throw error;
    }
  };
  const load = async (id: string, ctx: ExtensionContext) => {
    const manifest = manager.find(id);
    const unsupported = manifest.requires?.filter((r) => !support.has(r));
    if (unsupported?.length) throw new Error(`Host lacks: ${unsupported.join(", ")}`);
    const module = await manager.load(id);
    operations.signal.throwIfAborted();
    if (registry.get(id)) return;
    await activate(module, ctx);
  };
  const saveConfig = (update: Parameters<ConfigStore["update"]>[0]) => {
    config = store.update(update);
    for (const key of Object.keys(registry.defaults)) delete registry.defaults[key];
    Object.assign(registry.defaults, config.defaults);
  };
  registerManagement(pi, {
    manager,
    registry,
    config: () => config,
    save: saveConfig,
    load,
    restore: activate,
    refresh,
    report,
    signal: () => operations.signal,
    subagents,
  });
  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    if (operations.signal.aborted) operations = new AbortController();
    previousProvider = ctx.model?.provider;
    config = store.load();
    subagents.setEnabled(config.subagents === true);
    subagents.startSession(ctx.sessionManager.getSessionId());
    Object.assign(registry.defaults, config.defaults);
    for (const id of config.autoload) {
      try {
        await load(id, ctx);
      } catch (error) {
        report(ctx, `${id}: ${(error as Error).message}`, true);
      }
    }
    statusLine(ctx);
    installEnhanceFooter(ctx, command, () => footerLabels);
  });
  pi.on("model_select", async (event, ctx) => {
    const currentModel = (event.model ?? ctx.model) as ExtensionContext["model"];
    const current = currentModel?.provider;
    if (previousProvider !== undefined && current !== previousProvider)
      await registry.lifecycle("provider_change");
    previousProvider = current;
    statusLine({ ...ctx, model: currentModel });
    // Availability rules derived from the new model (e.g. view_image for text-only models)
    // re-synchronize registration; user-disabled tools still stay disabled inside refresh.
    synchronize({ ...ctx, model: currentModel });
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (disposed) return;
    const controls = registry.list().flatMap((e) => (e.instance.control ? [e.instance.control] : []));
    const payload = transformControlledRequest(
      event.payload,
      modelInfo(ctx.model),
      controls,
      config.controls,
    );
    if (payload !== event.payload) return payload;
  });
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.pi_enhance_release = releaseGuidance;
    const notices = registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    if (notices.length)
      return { message: { customType: "pi-enhance:recovery", content: notices.join("\n"), display: false } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await registry.lifecycle("task_settled", () => ctx.isIdle());
  });
  pi.on("session_tree", async () => {
    subagents.cancelAll();
    await registry.lifecycle("session_tree");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    subagents.shutdown();
    operations.abort();
    try {
      await registry.dispose();
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
