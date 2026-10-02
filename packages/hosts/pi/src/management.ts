import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PiPreferences, PreferenceStore } from "../../../integrations/services/src/preferences.ts";
import type { ServiceRuntime } from "../../../integrations/services/src/runtime.ts";
import { manageServicePreferences, serviceUsage } from "../../../integrations/services/src/management.ts";
import { requestControls } from "./requests/index.ts";
import type { Subagents } from "./subagents/index.ts";

interface ManagementOptions {
  runtime(): ServiceRuntime;
  store: PreferenceStore<PiPreferences>;
  preferences(): PiPreferences;
  subagents: Subagents;
  synchronize(ctx: ExtensionContext): Promise<void>;
  refresh(ctx: ExtensionContext): void;
  report(ctx: ExtensionContext, text: string, error?: boolean): void;
  signal(): AbortSignal;
}
const usage = `/pi-enhance ${serviceUsage}; fast on|off; verbosity off|low|medium|high; image_detail off|original; subagents enable|disable|status|model [provider/id|inherit]|cancel <batch-id>; computer status|reset|ask|auto|revoke`;
export function registerManagement(pi: ExtensionAPI, options: ManagementOptions): void {
  const { store, subagents, report } = options;
  const subagentsPanel = async (ctx: ExtensionCommandContext) => {
    const saved = options.preferences().subagents.model;
    const choice = await ctx.ui.select(
      `子代理 / Subagents · ${subagents.isEnabled() ? "已启用" : "未启用"}\n默认模型：${saved ?? "继承当前 Pi 模型"}`,
      ["选择默认模型", subagents.isEnabled() ? "禁用" : "启用", "状态"],
    );
    if (choice === "选择默认模型") await run("subagents model", ctx);
    else if (choice === "启用") await run("subagents enable", ctx);
    else if (choice === "禁用") await run("subagents disable", ctx);
    else if (choice === "状态") await run("subagents status", ctx);
  };
  const capabilityPanel = async (ctx: ExtensionCommandContext) => {
    const runtime = options.runtime();
    const capabilities = [
      ...new Map(runtime.options.modules.catalog.modules.map((e) => [e.capability, e])).values(),
    ];
    const labels = capabilities.map(
      (e) =>
        `${e.label} / ${e.capability} · ${runtime.states.filter((s) => s.module.startsWith(`${e.capability}/`) && s.status === "available").length} 个可用连接`,
    );
    const choice = await ctx.ui.select("能力 / Capabilities", labels);
    const entry = capabilities[labels.indexOf(choice ?? "")];
    if (!entry) return;
    const excluded = options.preferences().excluded.includes(entry.capability);
    const action = await ctx.ui.select(
      `${entry.label} · 偏好连接：${options.preferences().preferred[entry.capability] ?? "自动选择"}`,
      ["选择偏好连接", "使用自动选择", excluded ? "恢复自动提供" : "排除能力", "状态"],
    );
    if (action === "使用自动选择") await run(`prefer ${entry.capability} auto`, ctx);
    else if (action === "排除能力" || action === "恢复自动提供")
      await run(`${excluded ? "include" : "exclude"} ${entry.capability}`, ctx);
    else if (action === "状态")
      report(
        ctx,
        runtime.states
          .filter((s) => s.module.startsWith(`${entry.capability}/`))
          .map((s) => `${s.module} @ ${s.service ?? "—"}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`)
          .join("\n"),
      );
    else if (action === "选择偏好连接") {
      const ids = new Set(
        runtime.states
          .filter((s) => s.module.startsWith(`${entry.capability}/`) && s.service)
          .map((s) => s.service),
      );
      const connections = runtime.snapshot.connections.filter((c) => ids.has(c.id));
      const labels = connections.map((c) => `${c.id} · ${c.label}`);
      const selected = await ctx.ui.select("选择服务连接", labels);
      const connection = connections[labels.indexOf(selected ?? "")];
      if (connection) await run(`prefer ${entry.capability} ${connection.id}`, ctx);
    }
  };
  const panel = async (ctx: ExtensionCommandContext) => {
    const choice = await ctx.ui.select("Pi Enhance · 服务与偏好", [
      "服务商 / Services",
      "能力 / Capabilities",
      "请求增强 / Requests",
      "子代理 / Subagents",
      "状态 / Status",
      "刷新 / Refresh",
      "桌面管理 / Computer",
    ]);
    if (choice === "服务商 / Services") await run("services", ctx);
    else if (choice === "能力 / Capabilities") await capabilityPanel(ctx);
    else if (choice === "子代理 / Subagents") await subagentsPanel(ctx);
    else if (choice === "状态 / Status") await run("status", ctx);
    else if (choice === "刷新 / Refresh") await run("refresh", ctx);
    else if (choice === "桌面管理 / Computer") {
      const action = await ctx.ui.select("桌面管理", ["status", "reset", "ask", "auto", "revoke"]);
      if (action) await run(`computer ${action}`, ctx);
    } else if (choice === "请求增强 / Requests") {
      const selected = await ctx.ui.select(
        "请求增强",
        requestControls.map((c) => `${c.id}: ${options.preferences().requests[c.id] ?? "off"}`),
      );
      const control = requestControls.find((c) => selected?.startsWith(`${c.id}:`));
      if (control) await run(control.id, ctx);
    }
  };
  const run = async (text: string, ctx: ExtensionCommandContext): Promise<void> => {
    options.signal().throwIfAborted();
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (ctx.mode === "tui") await panel(ctx);
      else report(ctx, usage);
      return;
    }
    const [action, value, extra] = words;
    if (action === "subagents") {
      if (value === "status" && words.length === 2) {
        report(ctx, subagents.status(ctx));
        return;
      }
      if (value === "model" && words.length <= 3) {
        const models = subagents.availableModels(ctx);
        let selected = extra;
        if (!selected) {
          if (ctx.mode !== "tui")
            throw new Error("Use /pi-enhance subagents model <provider/id>|inherit outside TUI.");
          const inherit = "inherit current Pi model";
          const labels = models.map(
            (m) =>
              `${m.provider}/${m.id} · ${m.name} · ${m.input.join("/")} · ${m.reasoning ? "thinking" : "no thinking"}`,
          );
          const choice = await ctx.ui.select(
            `Subagent default model: ${options.preferences().subagents.model ?? inherit}`,
            [inherit, ...labels],
          );
          if (!choice) return;
          if (choice === inherit) selected = "inherit";
          else {
            const model = models[labels.indexOf(choice)];
            if (!model) throw new Error("Invalid model selection.");
            selected = `${model.provider}/${model.id}`;
          }
        }
        if (selected !== "inherit" && !models.some((m) => `${m.provider}/${m.id}` === selected))
          throw new Error(`Model ${selected} is not enabled and available in this Pi session.`);
        store.update((p) => ({
          ...p,
          subagents: { enabled: p.subagents.enabled, ...(selected === "inherit" ? {} : { model: selected }) },
        }));
        await options.synchronize(ctx);
        report(
          ctx,
          `Saved subagent default model: ${selected === "inherit" ? "inherit current Pi model" : selected}. No model calls.`,
        );
        return;
      }
      if ((value === "enable" || value === "disable") && words.length === 2) {
        store.update((p) => ({ ...p, subagents: { ...p.subagents, enabled: value === "enable" } }));
        await options.synchronize(ctx);
        report(ctx, `Subagents ${value === "enable" ? "enabled" : "disabled"}.`);
        return;
      }
      if (value === "cancel" && extra && words.length === 3) {
        report(
          ctx,
          subagents.cancel(extra)
            ? `Cancelling subagent batch ${extra}.`
            : `No active subagent batch ${extra}.`,
        );
        return;
      }
      throw new Error(usage);
    }
    const control = requestControls.find((c) => c.id === action);
    if (control) {
      if (words.length > 2) throw new Error(usage);
      let selected = value;
      if (!selected) {
        if (ctx.mode !== "tui")
          throw new Error(`Use /pi-enhance ${action} <${control.choices.join("|")}> outside TUI.`);
        selected = await ctx.ui.select(
          `${control.id}: ${options.preferences().requests[control.id] ?? "off"}`,
          [...control.choices],
        );
        if (!selected) return;
      }
      if (!control.choices.includes(selected)) throw new Error(`Choose ${control.choices.join(" / ")}`);
      store.update((p) => {
        const requests = { ...p.requests };
        if (selected === "off") delete requests[control.id];
        else requests[control.id] = selected!;
        return { ...p, requests };
      });
      await options.synchronize(ctx);
      report(
        ctx,
        `Saved ${control.id}: ${selected}. ${selected === "off" ? "No request override." : (control.enabledNotice ?? "Only applied to supported API/models.")}`,
      );
      return;
    }
    if (action === "computer" && words.length === 2) {
      const instance = options
        .runtime()
        .options.registry.list()
        .find((e) => e.instance.manage)?.instance;
      if (!instance) throw new Error("No ChatGPT desktop runtime was discovered.");
      report(ctx, await instance.manage!(value!));
      return;
    }
    if (action === "refresh" && words.length === 1) {
      await options.synchronize(ctx);
      report(ctx, options.runtime().describe() || "No services discovered.");
      return;
    }
    const result = manageServicePreferences(words, store, options.runtime());
    if (result === undefined) throw new Error(usage);
    if (!["status", "services"].includes(action!)) await options.synchronize(ctx);
    report(
      ctx,
      action === "status"
        ? `${result}\nRequests: ${JSON.stringify(options.preferences().requests)}\n${subagents.status(ctx)}`
        : result,
    );
  };
  let busy = false;
  pi.registerCommand("pi-enhance", {
    description: "Discover services and manage capability preferences",
    getArgumentCompletions(prefix) {
      const candidates = [
        "status",
        "services",
        "refresh",
        "subagents enable",
        "subagents disable",
        "subagents status",
        "subagents model",
        "subagents model inherit",
        ...requestControls.flatMap((c) => [c.id, ...c.choices.map((v) => `${c.id} ${v}`)]),
        ...new Set(
          options
            .runtime()
            .options.modules.catalog.modules.flatMap((e) => [
              `prefer ${e.capability} auto`,
              `exclude ${e.capability}`,
              `include ${e.capability}`,
            ]),
        ),
        ...options
          .runtime()
          .states.flatMap((s) => (s.service ? [`prefer ${s.module.split("/")[0]} ${s.service}`] : [])),
      ];
      return candidates.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(text, ctx) {
      if (busy) {
        report(ctx, "Another preference operation is running.", true);
        return;
      }
      busy = true;
      try {
        await ctx.waitForIdle();
        await options.synchronize(ctx);
        await run(text, ctx);
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : String(error), true);
      } finally {
        busy = false;
      }
    },
  });
}
