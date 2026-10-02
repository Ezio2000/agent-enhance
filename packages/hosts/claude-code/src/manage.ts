import { PreferenceStore, emptyPreferences } from "../../../integrations/services/src/preferences.ts";
import { ModuleCatalog, type Catalog } from "../../../integrations/services/src/catalog.ts";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import { ServiceRuntime } from "../../../integrations/services/src/runtime.ts";
import { fileSources } from "../../../integrations/services/src/sources/files.ts";
import { manageServicePreferences, serviceUsage } from "../../../integrations/services/src/management.ts";
import { send, sessionSockets } from "./control.ts";
import { HOST_ID, SERVER_NAME, artifactRoot } from "./paths.ts";
import { SUPPORTED_REQUIREMENTS } from "./server.ts";

export const USAGE = `/cc-enhance ${serviceUsage}; computer status|reset|ask|auto|revoke`;
export interface ManageOptions {
  home: string;
  catalog: Catalog;
  moduleDirectory: string;
}
export async function manage(args: string[], options: ManageOptions): Promise<string> {
  const store = new PreferenceStore(options.home, HOST_ID, emptyPreferences);
  const runtime = new ServiceRuntime({
    modules: new ModuleCatalog(options.catalog, options.moduleDirectory),
    registry: new CapabilityRegistry(),
    services: (entry) => ({ artifactRoot: artifactRoot(options.home, entry.capability, entry.provider) }),
  });
  const notify = async () => {
    const session = sessionSockets();
    if (!session) return "";
    const results = await Promise.allSettled(
      Object.values(session.sockets).map((path) => send(path, { op: "refresh" })),
    );
    return results
      .flatMap((result) =>
        result.status === "rejected" ? [`Live refresh failed: ${String(result.reason)}`] : [],
      )
      .join("\n");
  };
  try {
    const [action, value] = args;
    if (!action || action === "help") return USAGE;
    if (action === "computer" && args.length === 2) {
      const path = sessionSockets()?.sockets[SERVER_NAME];
      if (!path) return "cc-enhance server is not running in this Claude Code session.";
      return String(await send(path, { op: "manage", action: value! }, 60_000));
    }
    await runtime.synchronize(fileSources({ home: options.home }), store.load(), {
      features: SUPPORTED_REQUIREMENTS,
    });
    if (action === "refresh" && args.length === 1) {
      const live = await notify();
      return [runtime.describe() || "No services discovered.", live].filter(Boolean).join("\n");
    }
    const result = manageServicePreferences(args, store, runtime);
    if (result === undefined) throw new Error(USAGE);
    if (!["status", "services"].includes(action)) return [result, await notify()].filter(Boolean).join("\n");
    if (action === "status") {
      const session = sessionSockets();
      if (!session) return `${result}\nLive session: no cc-enhance server found.`;
      const lines = [result, `Live session (Claude Code pid ${session.pid}):`];
      for (const path of Object.values(session.sockets)) {
        try {
          const state = (await send(path, { op: "status" })) as {
            loaded: string[];
            errors: Record<string, string>;
          };
          lines.push(
            `  loaded: ${state.loaded.join(", ") || "none"}`,
            ...Object.entries(state.errors).map(([id, error]) => `  ${id}: ${error}`),
          );
        } catch (error) {
          lines.push(`  server unreachable: ${String(error)}`);
        }
      }
      return lines.join("\n");
    }
    return result;
  } finally {
    await runtime.dispose();
  }
}
