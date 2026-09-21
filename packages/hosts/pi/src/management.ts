import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { CapabilityModule } from "../../../core/src/contracts.ts";
import type { HostConfig } from "../../../core/src/config.ts";
import type { ModuleManager, CatalogEntry } from "../../../core/src/modules.ts";
import type { CapabilityRegistry } from "../../../core/src/registry.ts";
import { PiCredentialResolver } from "./auth.ts";

interface ManagementOptions {
  manager: ModuleManager;
  registry: CapabilityRegistry;
  config(): HostConfig;
  save(update: (config: HostConfig) => HostConfig): void;
  load(id: string, ctx: ExtensionContext): Promise<void>;
  restore(module: CapabilityModule, ctx: ExtensionContext): Promise<void>;
  refresh(ctx: ExtensionContext): void;
  report(ctx: ExtensionContext, text: string, error?: boolean): void;
  signal(): AbortSignal;
}
const groups = [
  { label: "图片生成 / Images", capabilities: ["gen_image"] },
  { label: "视频生成 / Video", capabilities: ["gen_video"] },
  { label: "语音合成 / Voice", capabilities: ["gen_voice"] },
  { label: "联网搜索 / Search", capabilities: ["search_web"] },
  { label: "文件理解 / File understanding", capabilities: ["view_pdf", "view_video", "view_image"] },
  { label: "桌面操作 / Computer use", capabilities: ["use_computer"] },
  { label: "请求增强 / Request enhancements", capabilities: ["fast", "verbosity", "image_detail"] },
];
const usage =
  "/pi-enhance <provider> <capability> enable|disable|install|load [--save]|unload [--save]|uninstall|update|status|manage; /pi-enhance defaults <capability> <provider>; /pi-enhance status|catalog|updates|update --installed";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Commands/panels are separate from Pi tool registration and lifecycle bridging. */
export function registerManagement(pi: ExtensionAPI, options: ManagementOptions): void {
  const { manager, registry, config, save, load, refresh, report } = options;
  const setAutoload = (id: string, enabled: boolean) =>
    save((c) => ({
      ...c,
      autoload: enabled ? [...new Set([...c.autoload, id])] : c.autoload.filter((value) => value !== id),
    }));
  const state = (entry: CatalogEntry) => {
    const installed = manager.installed(entry.id);
    return [
      installed ? "installed" : "not installed",
      registry.get(entry.id) ? "loaded" : "unloaded",
      config().autoload.includes(entry.id) ? "autoload:on" : "autoload:off",
      installed && installed.sha256 !== entry.sha256 ? "update available" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  };
  const requirements = (entry: CatalogEntry) =>
    [
      `${entry.id} · ${entry.version} · ${(entry.bytes / 1024).toFixed(1)} KiB`,
      `Platform: ${entry.platforms?.join(", ") ?? "all supported Node.js platforms"}`,
      entry.auth
        ? `Auth: ${entry.auth.provider}/${entry.auth.channel} (${entry.auth.acceptedKinds.join("/")}); configure via /login`
        : entry.capability === "use_computer"
          ? "Requires compatible ChatGPT desktop runtime, local login and macOS permissions; checked on first use"
          : "Auth: follows the supported main-model request",
      `State: ${state(entry)}`,
    ].join("\n");
  const status = async (ctx: ExtensionContext, only?: CatalogEntry) => {
    const credentials = new PiCredentialResolver(ctx.modelRegistry);
    const lines: string[] = [];
    for (const entry of only ? [only] : manager.catalog.modules) {
      let auth = "not checked";
      if (entry.auth)
        auth = (await credentials.resolve(entry.auth, { signal: ctx.signal, interactive: false })).status;
      else auth = entry.capability === "use_computer" ? "runtime checked on first use" : "main-model auth";
      const availability =
        entry.kind === "tool"
          ? `, tool:${registry.get(entry.id) && pi.getActiveTools().includes(entry.capability) ? "active" : "inactive (unloaded, model rule or host exclusion)"}`
          : "";
      lines.push(`${entry.id}: ${state(entry)}, auth:${auth}${availability}`);
      if (only && registry.get(entry.id)?.instance.status)
        lines.push(JSON.stringify(registry.get(entry.id)!.instance.status!(), null, 2));
    }
    if (!only)
      lines.push(
        `Defaults: ${JSON.stringify(config().defaults)}`,
        `Controls: ${JSON.stringify(config().controls)}`,
        `Home: ${manager.home}`,
      );
    return lines.join("\n");
  };
  const update = async (ctx: ExtensionContext, ids?: string[]) => {
    const updated = await manager.update(ids, options.signal());
    report(
      ctx,
      updated.length
        ? `Updated ${updated.join(", ")}. Loaded instances are unchanged; new code is used on the next load/reload. Autoload and control preferences retained.`
        : "Installed modules match this host catalog. No downloads. Update the pi-enhance package first to obtain a newer catalog.",
    );
  };
  const remove = async (id: string, ctx: ExtensionContext, persist: boolean, uninstall: boolean) => {
    registry.assertIdle(id);
    const wasAutoload = config().autoload.includes(id);
    const previous = registry.get(id);
    const active = pi.getActiveTools();
    let saved = false;
    try {
      // Persist first: a locked/corrupt config must not tear down a working instance.
      if (persist) {
        setAutoload(id, false);
        saved = true;
      }
      await registry.unload(id);
      refresh(ctx);
      if (uninstall) manager.uninstall(id);
    } catch (error) {
      const failures: string[] = [errorText(error)];
      try {
        if (saved) setAutoload(id, wasAutoload);
      } catch (rollback) {
        failures.push(`Autoload recovery failed: ${errorText(rollback)}`);
      }
      try {
        // Use the original module object, not a potentially changed on-disk installation.
        if (previous && !registry.get(id)) {
          await options.restore(previous.module, ctx);
          pi.setActiveTools(active);
        }
      } catch (rollback) {
        failures.push(`Runtime recovery failed; reload explicitly: ${errorText(rollback)}`);
      }
      throw new Error(failures.join("\n"));
    }
  };
  const modulePanel = async (entry: CatalogEntry, ctx: ExtensionCommandContext) => {
    const installed = manager.installed(entry.id);
    const loaded = registry.get(entry.id);
    const choices = [
      ...(!loaded || !config().autoload.includes(entry.id) ? ["enable"] : []),
      ...(!installed ? ["install"] : []),
      ...(installed && !loaded ? ["load", "load --save"] : []),
      ...(loaded || config().autoload.includes(entry.id) ? ["disable"] : []),
      ...(loaded ? ["unload"] : []),
      ...(installed ? ["update", "uninstall"] : []),
      ...(entry.kind === "tool" ? ["set default"] : []),
      ...(loaded?.instance.control ? ["settings"] : []),
      ...(loaded?.instance.manage ? ["ask", "auto", "reset", "revoke"] : []),
      "status",
    ];
    const action = await ctx.ui.select(
      `${requirements(entry)}\nEnable installs only this module; no model calls. Saved control values are retained.`,
      choices,
    );
    if (!action) return;
    if (action === "set default") await run(`defaults ${entry.capability} ${entry.provider}`, ctx);
    else await run(`${entry.provider} ${entry.capability}${action === "settings" ? "" : ` ${action}`}`, ctx);
  };
  const panel = async (ctx: ExtensionCommandContext) => {
    const known = new Set(groups.flatMap((group) => group.capabilities));
    const available = [
      ...groups,
      ...manager.catalog.modules
        .filter((e) => !known.has(e.capability))
        .map((e) => ({ label: e.capability, capabilities: [e.capability] })),
    ].filter((group) => manager.catalog.modules.some((e) => group.capabilities.includes(e.capability)));
    const selected = await ctx.ui.select("Pi Enhance · 按功能选择", [
      ...available.map((g) => g.label),
      "status",
      "catalog",
      "updates",
      "update --installed",
    ]);
    if (!selected) return;
    const group = available.find((g) => g.label === selected);
    if (!group) {
      await run(selected, ctx);
      return;
    }
    const entries = manager.catalog.modules.filter((e) => group.capabilities.includes(e.capability));
    const labels = entries.map((e) => `${e.capability} / ${e.provider} · ${state(e)}`);
    const choice = await ctx.ui.select(group.label, labels);
    const entry = entries[labels.indexOf(choice ?? "")];
    if (entry) await modulePanel(entry, ctx);
  };
  const run = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    options.signal().throwIfAborted();
    const words = args.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (ctx.mode !== "tui") report(ctx, usage);
      else await panel(ctx);
      return;
    }
    if (words[0] === "status" && words.length === 1) {
      report(ctx, await status(ctx));
      return;
    }
    if (words[0] === "catalog" && words.length === 1) {
      report(ctx, manager.catalog.modules.map(requirements).join("\n\n"));
      return;
    }
    if (words[0] === "updates" && words.length === 1) {
      const entries = manager.updates();
      report(
        ctx,
        entries.length
          ? entries
              .map(
                (e) =>
                  `${e.id}: ${manager.installed(e.id)!.sha256.slice(0, 12)} → ${e.sha256.slice(0, 12)} (${(e.bytes / 1024).toFixed(1)} KiB)`,
              )
              .join("\n")
          : "No updates in this host catalog. Update the pi-enhance package first to obtain a newer catalog.",
      );
      return;
    }
    if (words.join(" ") === "update --installed") {
      await update(ctx);
      return;
    }
    if (words[0] === "defaults" && words.length === 3) {
      const [, capability, provider] = words;
      if (manager.find(`${capability}/${provider}`).kind !== "tool")
        throw new Error("Only tools have default providers.");
      save((c) => ({ ...c, defaults: { ...c.defaults, [capability!]: provider! } }));
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
    if (!action || action === "manage") {
      if (ctx.mode !== "tui") throw new Error("Explicit action/value required outside TUI.");
      const control = registry.get(id)?.instance.control;
      // Preserve the existing direct request-control picker and its single-selection behavior.
      if (!action && control) {
        const choice = await ctx.ui.select(`${id}: ${config().controls[control.id] ?? "off"}`, [
          ...control.choices,
        ]);
        if (choice) await run(`${provider} ${capability} ${choice}`, ctx);
      } else await modulePanel(entry, ctx);
      return;
    }
    if (action === "install") {
      await manager.install(id, options.signal());
      report(
        ctx,
        `Installed ${id}; not loaded by this operation. Run /pi-enhance ${provider} ${capability} enable.`,
      );
      return;
    }
    if (action === "update") {
      await update(ctx, [id]);
      return;
    }
    if (action === "enable" || action === "load") {
      if (entry.platforms && !entry.platforms.includes(process.platform))
        throw new Error(`Module requires ${entry.platforms.join(", ")}.`);
      const wasLoaded = !!registry.get(id);
      if (action === "enable" && !manager.installed(id)) await manager.install(id, options.signal());
      options.signal().throwIfAborted();
      await load(id, ctx);
      try {
        if (persist || action === "enable") setAutoload(id, true);
      } catch (error) {
        if (!wasLoaded) {
          await registry.unload(id);
          refresh(ctx);
        }
        throw error;
      }
      report(
        ctx,
        `${action === "enable" ? "Enabled" : "Loaded"} ${id}${persist || action === "enable" ? "; saved for future Pi sessions" : "; session only"}. No model calls. Saved control values retained.${entry.auth ? ` Auth required: ${entry.auth.provider}/${entry.auth.channel}; use /login and status to check readiness.` : ""}`,
      );
      return;
    }
    if (action === "disable" || action === "unload" || action === "uninstall") {
      await remove(id, ctx, persist || action !== "unload", action === "uninstall");
      report(
        ctx,
        `${action}: ${id}. Historical artifacts retained.${action === "disable" ? " Installation and control preferences retained." : ""}`,
      );
      return;
    }
    if (action === "status") {
      report(ctx, await status(ctx, entry));
      return;
    }
    const instance = registry.get(id)?.instance;
    if (!instance) throw new Error(`Load ${id} first. No implicit downloads or loading.`);
    if (instance.control) {
      const control = instance.control,
        value = control.aliases?.[action] ?? action;
      if (!control.choices.includes(value)) throw new Error(`Choose ${control.choices.join(" / ")}`);
      save((c) => ({ ...c, controls: { ...c.controls, [control.id]: value } }));
      refresh(ctx);
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
  let busy = false;
  pi.registerCommand("pi-enhance", {
    description: "Optional capabilities: browse, enable, disable and update installed modules",
    getArgumentCompletions(prefix) {
      const candidates = [
        "status",
        "catalog",
        "updates",
        "update --installed",
        ...manager.catalog.modules.flatMap((e) =>
          [
            "",
            "enable",
            "disable",
            "install",
            "load",
            "load --save",
            "unload",
            "unload --save",
            "uninstall",
            "update",
            "status",
            "manage",
            ...(e.kind === "request-control"
              ? e.capability === "verbosity"
                ? ["off", "low", "medium", "high"]
                : ["off", "on"]
              : e.capability === "use_computer"
                ? ["ask", "auto", "reset", "revoke"]
                : []),
          ].map((a) => `${e.provider} ${e.capability}${a ? ` ${a}` : ""}`),
        ),
        ...manager.catalog.modules
          .filter((e) => e.kind === "tool")
          .map((e) => `defaults ${e.capability} ${e.provider}`),
      ];
      const items = candidates
        .filter((c) => c.startsWith(prefix.trimStart()))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (busy) {
        report(ctx, "Another pi-enhance operation is running. Retry after it finishes.", true);
        return;
      }
      busy = true;
      try {
        await ctx.waitForIdle();
        await run(args, ctx);
      } catch (error) {
        report(ctx, errorText(error), true);
      } finally {
        busy = false;
      }
    },
  });
}
