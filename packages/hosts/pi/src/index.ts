import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resizeImage,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import { ConfigStore, enhanceHome } from "../../../core/src/config.ts";
import { ModuleManager, type Catalog } from "../../../core/src/modules.ts";
import { transformControlledRequest } from "../../../core/src/controls.ts";
import type { ExecutionContext, ModelInfo } from "../../../core/src/contracts.ts";
import { PiCredentialResolver } from "./auth.ts";
import { piHistory } from "./history.ts";
import { installEnhanceFooter, type FooterLabel } from "./footer.ts";

const command = "pi-enhance";
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
  let previousProvider: string | undefined;
  let disposed = false;
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
  const refresh = (ctx: ExtensionContext) => {
    const tools = registry.tools();
    const active = new Set(pi.getActiveTools());
    for (const tool of tools) {
      const collision = pi.getAllTools().find((t) => t.name === tool.name);
      if (collision && !knownNames.has(tool.name))
        throw new Error(`Tool collision: ${tool.name}; disable the conflicting extension first.`);
      pi.registerTool({
        ...tool,
        execute: (id, args, signal, update, piContext) =>
          tool.execute(id, args, signal, update, executionContext(piContext)),
      });
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
  const load = async (id: string, ctx: ExtensionContext) => {
    const manifest = manager.find(id);
    const unsupported = manifest.requires?.filter((r) => !support.has(r));
    if (unsupported?.length) throw new Error(`Host lacks: ${unsupported.join(", ")}`);
    const module = await manager.load(id);
    registry.load(module, {
      artifactRoot: join(options.home, "artifacts", "pi", manifest.capability, manifest.provider),
      preview: (bytes, mime) =>
        resizeImage(bytes, mime, { maxWidth: 1024, maxHeight: 1024, maxBytes: 512 * 1024 }),
    });
    try {
      synchronize(ctx);
    } catch (error) {
      await registry.unload(id);
      throw error;
    }
  };
  const saveConfig = (update: Parameters<ConfigStore["update"]>[0]) => {
    config = store.update(update);
    for (const key of Object.keys(registry.defaults)) delete registry.defaults[key];
    Object.assign(registry.defaults, config.defaults);
  };
  const status = async (ctx: ExtensionContext) => {
    const credentials = new PiCredentialResolver(ctx.modelRegistry);
    const lines = [];
    for (const entry of options.catalog.modules) {
      const loaded = registry.get(entry.id);
      let ready = "—";
      if (loaded) {
        if (entry.auth)
          ready = (await credentials.resolve(entry.auth, { signal: ctx.signal, interactive: false })).status;
        else if (entry.capability === "use_computer") ready = "runtime checked on first use";
        else ready = "ready";
      }
      lines.push(
        `${entry.id}: ${manager.installed(entry.id) ? "installed" : "not installed"}, ${loaded ? "loaded" : "unloaded"}, ${ready}`,
      );
    }
    return [
      ...lines,
      `Defaults: ${JSON.stringify(config.defaults)}`,
      `Controls: ${JSON.stringify(config.controls)}`,
      `Home: ${options.home}`,
    ].join("\n");
  };
  const usage =
    "/pi-enhance <provider> <capability> install|load [--save]|unload [--save]|uninstall|status; /pi-enhance openai fast on; /pi-enhance defaults gen_image openai; /pi-enhance status|catalog";
  const run = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (disposed) return;
    await ctx.waitForIdle();
    const words = args.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (ctx.mode !== "tui") {
        report(ctx, usage);
        return;
      }
      const choices = [
        "status",
        "catalog",
        ...options.catalog.modules.map((e) => `${e.provider} ${e.capability}`),
      ];
      const chosen = await ctx.ui.select("Pi Enhance", choices);
      if (chosen) await run(chosen, ctx);
      return;
    }
    if (words[0] === "status" && words.length === 1) {
      report(ctx, await status(ctx));
      return;
    }
    if (words[0] === "catalog" && words.length === 1) {
      report(ctx, options.catalog.modules.map((e) => `${e.id} (${e.kind}, ${e.version})`).join("\n"));
      return;
    }
    if (words[0] === "defaults" && words.length === 3) {
      const [, capability, provider] = words;
      const entry = manager.find(`${capability}/${provider}`);
      if (entry.kind !== "tool") throw new Error("Only tools have default providers.");
      saveConfig((c) => ({ ...c, defaults: { ...c.defaults, [capability!]: provider! } }));
      report(ctx, `Saved default ${capability}: ${provider}. No backend calls were made.`);
      return;
    }
    if (words.length < 2 || words.length > 4 || (words.length === 4 && words[3] !== "--save"))
      throw new Error(usage);
    const [provider, capability, action] = words;
    const id = `${capability}/${provider}`,
      entry = manager.find(id);
    const persist = words[3] === "--save";
    if (persist && action !== "load" && action !== "unload")
      throw new Error("--save is valid only with load/unload.");
    if (!action) {
      if (ctx.mode !== "tui") throw new Error("Explicit action/value required outside TUI.");
      if (!registry.get(id)) {
        const action = await ctx.ui.select(
          id,
          manager.installed(id) ? ["load", "load --save", "uninstall"] : ["install"],
        );
        if (action) await run(`${provider} ${capability} ${action}`, ctx);
        return;
      }
      // One selection applies immediately and closes the panel; Esc cancels without changing anything.
      const control = registry.get(id)?.instance.control;
      if (control) {
        const choice = await ctx.ui.select(`${id}: ${config.controls[control.id] ?? "off"}`, [
          ...control.choices,
        ]);
        if (choice) await run(`${provider} ${capability} ${choice}`, ctx);
      } else {
        const choice = await ctx.ui.select(
          id,
          capability === "use_computer"
            ? ["status", "ask", "auto", "reset", "revoke", "unload"]
            : ["status", "unload"],
        );
        if (choice) await run(`${provider} ${capability} ${choice}`, ctx);
      }
      return;
    }
    if (action === "install") {
      await manager.install(id);
      report(ctx, `Installed ${id}; not loaded. Run /pi-enhance ${provider} ${capability} load --save.`);
      return;
    }
    if (action === "load") {
      const wasLoaded = !!registry.get(id);
      await load(id, ctx);
      try {
        if (persist) saveConfig((c) => ({ ...c, autoload: [...new Set([...c.autoload, id])] }));
      } catch (error) {
        if (!wasLoaded) {
          await registry.unload(id);
          synchronize(ctx);
        }
        throw error;
      }
      report(ctx, `Loaded ${id}${persist ? "; saved for future Pi sessions" : "; session only"}.`);
      return;
    }
    if (action === "unload" || action === "uninstall") {
      if (persist || action === "uninstall")
        saveConfig((c) => ({ ...c, autoload: c.autoload.filter((value) => value !== id) }));
      await registry.unload(id);
      synchronize(ctx);
      if (action === "uninstall") manager.uninstall(id);
      report(ctx, `${action}: ${id}. Historical artifacts retained.`);
      return;
    }
    if (action === "status") {
      report(
        ctx,
        registry.get(id)?.instance.status
          ? JSON.stringify(registry.get(id)!.instance.status!(), null, 2)
          : ((await status(ctx)).split("\n").find((line) => line.startsWith(id)) ?? id),
      );
      return;
    }
    const instance = registry.get(id)?.instance;
    if (!instance) throw new Error(`Load ${id} first. No implicit downloads or loading.`);
    if (instance.control) {
      const control = instance.control,
        value = control.aliases?.[action] ?? action;
      if (!control.choices.includes(value)) throw new Error(`Choose ${control.choices.join(" / ")}`);
      saveConfig((c) => ({ ...c, controls: { ...c.controls, [control.id]: value } }));
      statusLine(ctx);
      report(
        ctx,
        `Saved ${control.id}: ${value}. ${value === "off" ? "No request override." : (control.enabledNotice ?? "Only applied to supported API/models.")}`,
      );
      return;
    }
    if (instance.manage) {
      report(ctx, await instance.manage(action));
      return;
    }
    throw new Error(usage);
  };
  pi.registerCommand(command, {
    description: "Capability installation, loading and provider settings",
    getArgumentCompletions(prefix) {
      const candidates = [
        "status",
        "catalog",
        ...options.catalog.modules.flatMap((e) =>
          [
            "",
            "install",
            "load",
            "load --save",
            "unload",
            "unload --save",
            "uninstall",
            "status",
            ...(e.kind === "request-control"
              ? e.capability === "verbosity"
                ? ["off", "low", "medium", "high"]
                : ["off", "on"]
              : e.capability === "use_computer"
                ? ["ask", "auto", "reset", "revoke"]
                : []),
          ].map((a) => `${e.provider} ${e.capability}${a ? ` ${a}` : ""}`),
        ),
        ...options.catalog.modules
          .filter((e) => e.kind === "tool")
          .map((e) => `defaults ${e.capability} ${e.provider}`),
      ];
      const items = candidates
        .filter((c) => c.startsWith(prefix.trimStart()))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await run(args, ctx);
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : "Enhancement operation failed", true);
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    previousProvider = ctx.model?.provider;
    config = store.load();
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
    // Never reactivate tools here: user-disabled tools remain disabled.
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
  pi.on("before_agent_start", () => {
    const notices = registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    if (notices.length)
      return { message: { customType: "pi-enhance:recovery", content: notices.join("\n"), display: false } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await registry.lifecycle("task_settled", () => ctx.isIdle());
  });
  pi.on("session_tree", async () => {
    await registry.lifecycle("session_tree");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
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
