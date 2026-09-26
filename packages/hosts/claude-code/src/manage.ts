import { ConfigStore, type HostConfig } from "../../../core/src/config.ts";
import { ModuleManager, type Catalog, type CatalogEntry } from "../../../core/src/modules.ts";
import { ClaudeCodeCredentialResolver } from "./credentials.ts";
import { send, sessionSockets } from "./control.ts";
import { login, logout } from "./login.ts";
import { HOST_ID } from "./paths.ts";
import { SUPPORTED_REQUIREMENTS } from "./server.ts";

export const USAGE = `Usage:
  /cc-enhance status                                 modules, credentials, defaults, live session state
  /cc-enhance catalog                                every capability/provider in this release
  /cc-enhance <provider> <capability> enable         install if missing + autoload (applies live)
  /cc-enhance <provider> <capability> disable        stop loading; keeps installation
  /cc-enhance <provider> <capability> install|uninstall|update|status
  /cc-enhance defaults <capability> <provider>       default provider when several are enabled
  /cc-enhance updates | update --installed           compare / update installed modules to this release
  /cc-enhance computer status|reset|ask|auto|revoke  manage the live use_computer bridge
  /cc-enhance login [...] | logout <provider>        provider credentials (run "login" for details)`;

const LABELS: Record<string, string> = {
  gen_image: "图片生成",
  gen_video: "视频生成",
  gen_voice: "语音合成",
  search_web: "联网搜索",
  view_pdf: "PDF 理解",
  view_video: "视频理解",
  view_image: "图片理解",
  use_computer: "桌面操作",
  fast: "请求增强",
  verbosity: "请求增强",
  image_detail: "请求增强",
};
export interface ManageOptions {
  home: string;
  catalog: Catalog;
  moduleDirectory: string;
}
/** Why this host can never load an entry, or undefined when it can. */
export function unsupportedReason(entry: CatalogEntry): string | undefined {
  if (entry.kind !== "tool")
    return "request controls need request interception, which Claude Code does not expose";
  const missing = entry.requires?.filter((r) => !SUPPORTED_REQUIREMENTS.has(r)) ?? [];
  if (missing.length) return `host lacks ${missing.join(", ")}`;
  if (entry.platforms && !entry.platforms.includes(process.platform))
    return `requires ${entry.platforms.join(", ")}`;
}

export async function manage(args: string[], options: ManageOptions): Promise<string> {
  const { home, catalog } = options;
  const manager = new ModuleManager(home, catalog, options.moduleDirectory);
  const store = new ConfigStore(home, HOST_ID);
  const setAutoload = (id: string, on: boolean) =>
    store.update((c: HostConfig) => ({
      ...c,
      autoload: on ? [...new Set([...c.autoload, id])] : c.autoload.filter((x) => x !== id),
    }));
  const state = (entry: CatalogEntry, config: HostConfig) => {
    const installed = manager.installed(entry.id);
    return [
      config.autoload.includes(entry.id) ? "enabled" : "disabled",
      installed ? "installed" : "not installed",
      installed && installed.sha256 !== entry.sha256 ? "update available" : undefined,
      unsupportedReason(entry) ? `unsupported: ${unsupportedReason(entry)}` : undefined,
    ]
      .filter(Boolean)
      .join(", ");
  };
  const live = async () => {
    const session = sessionSockets();
    if (!session) return "Live session: no cc-enhance servers found for this Claude Code session.";
    const lines = [`Live session (Claude Code pid ${session.pid}):`];
    for (const [capability, path] of Object.entries(session.sockets).sort()) {
      try {
        const status = (await send(path, { op: "status" })) as {
          loaded: string[];
          errors: Record<string, string>;
        };
        lines.push(
          `  ${capability}: ${status.loaded.length ? status.loaded.join(", ") : "no provider loaded"}` +
            Object.entries(status.errors)
              .map(([id, error]) => `\n    ! ${id}: ${error}`)
              .join(""),
        );
      } catch (error) {
        lines.push(`  ${capability}: unreachable (${(error as Error).message})`);
      }
    }
    return lines.join("\n");
  };
  const status = async (only?: CatalogEntry) => {
    const config = store.load();
    const credentials = new ClaudeCodeCredentialResolver(home);
    const lines: string[] = [];
    for (const entry of only ? [only] : catalog.modules) {
      const auth = entry.auth
        ? (await credentials.resolve(entry.auth, { interactive: false })).status
        : entry.capability === "use_computer"
          ? "ChatGPT desktop runtime (checked on first use)"
          : "none";
      lines.push(
        `${entry.id.padEnd(22)} ${LABELS[entry.capability] ?? ""}  ${state(entry, config)}; auth: ${auth}`,
      );
    }
    if (!only)
      lines.push(
        "",
        `Defaults: ${JSON.stringify(config.defaults)}`,
        `Home: ${home}`,
        "",
        await live(),
        "",
        USAGE,
      );
    return lines.join("\n");
  };

  const [first, second, action, ...rest] = args;
  if (!first || first === "help") return USAGE;
  if (first === "status") return status();
  if (first === "catalog")
    return catalog.modules
      .map(
        (e) =>
          `${e.id.padEnd(22)} ${e.version}  ${(e.bytes / 1024).toFixed(1)} KiB  ${e.auth ? `${e.auth.provider}/${e.auth.channel}` : "no auth"}${unsupportedReason(e) ? `  (unsupported: ${unsupportedReason(e)})` : ""}`,
      )
      .join("\n");
  if (first === "login") return login(home, args.slice(1));
  if (first === "logout") return logout(home, second);
  if (first === "updates") {
    const updates = manager.updates();
    return updates.length
      ? `Updates available: ${updates.map((e) => e.id).join(", ")}`
      : "Installed modules match this release.";
  }
  if (first === "update" && second === "--installed") {
    const updated = await manager.update();
    return updated.length
      ? `Updated ${updated.join(", ")}. Running servers pick up new code after /reload-plugins or a new session.`
      : "Installed modules already match this release.";
  }
  if (first === "defaults") {
    if (!second || !action) return "Usage: /cc-enhance defaults <capability> <provider>";
    manager.find(`${second}/${action}`);
    store.update((c) => ({ ...c, defaults: { ...c.defaults, [second]: action } }));
    return `Default provider for ${second}: ${action}.`;
  }
  if (first === "computer") {
    const session = sessionSockets();
    const path = session?.sockets.use_computer;
    if (!path) return "use_computer server is not running in this Claude Code session.";
    return String(await send(path, { op: "manage", action: second ?? "status" }, 60_000));
  }
  if (!second || !action) return USAGE;
  const entry = manager.find(`${second}/${first}`);
  const id = entry.id;
  switch (action) {
    case "enable": {
      const reason = unsupportedReason(entry);
      if (reason) throw new Error(`${id} cannot run in Claude Code: ${reason}.`);
      const installed = manager.installed(id);
      if (installed && installed.sha256 !== entry.sha256)
        throw new Error(
          `${id} is installed from another release; run /cc-enhance ${first} ${second} update first.`,
        );
      if (!installed) await manager.install(id);
      await manager.load(id); // Verify integrity and contract before saving autoload.
      setAutoload(id, true);
      const auth = entry.auth
        ? await new ClaudeCodeCredentialResolver(home).resolve(entry.auth, { interactive: false })
        : undefined;
      return [
        `Enabled ${id}. The ${second} tool updates live in running sessions.`,
        auth && auth.status !== "ready" ? `Credentials: ${auth.guidance}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "disable":
      setAutoload(id, false);
      return `Disabled ${id}; installation kept.`;
    case "install":
      await manager.install(id);
      return `Installed ${id} (not enabled).`;
    case "uninstall":
      setAutoload(id, false);
      manager.uninstall(id);
      return `Uninstalled ${id}. Artifacts are kept.`;
    case "update": {
      const updated = await manager.update([id]);
      return updated.length
        ? `Updated ${id}; running servers use it after /reload-plugins.`
        : `${id} is up to date.`;
    }
    case "status":
      return status(entry);
    default:
      return `Unknown action ${action}${rest.length ? " " + rest.join(" ") : ""}.\n${USAGE}`;
  }
}
