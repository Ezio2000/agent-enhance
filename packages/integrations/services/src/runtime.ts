import { EnhanceError } from "../../../core/src/auth.ts";
import type { ModelInfo, ModuleServices } from "../../../core/src/contracts.ts";
import { CapabilityRegistry } from "../../../core/src/registry.ts";
import type { Preferences } from "./preferences.ts";
import {
  discoverServices,
  type ServiceConnection,
  type ServiceSource,
  type ServiceSnapshot,
} from "./contracts.ts";
import { ModuleCatalog, type CatalogEntry } from "./catalog.ts";

export interface CapabilityState {
  module: string;
  service?: string;
  status: "available" | "missing" | "excluded" | "unsupported" | "hidden" | "error" | "busy";
  reason?: string;
}
export interface HostConditions {
  features: ReadonlySet<string>;
  model?: ModelInfo;
  platform?: NodeJS.Platform;
}
export interface ServiceRuntimeOptions {
  modules: ModuleCatalog;
  registry: CapabilityRegistry;
  services(entry: CatalogEntry, connection: ServiceConnection): ModuleServices;
}
/** Integration policy only: discovery and host conditions are translated to explicit Core bindings. */
export class ServiceRuntime {
  snapshot: ServiceSnapshot = { connections: [], errors: {} };
  states: CapabilityState[] = [];
  private syncing: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(readonly options: ServiceRuntimeOptions) {}
  synchronize(
    sources: readonly ServiceSource[],
    preferences: Preferences,
    host: HostConditions,
    signal?: AbortSignal,
  ): Promise<void> {
    const operation = this.syncing
      .catch(() => {})
      .then(async () => {
        if (this.stopped) return;
        signal?.throwIfAborted();
        const discovered = await discoverServices(sources);
        signal?.throwIfAborted();
        if (this.stopped) return;
        // A failed source is unknown, not a logout. Preserve only that source's last known connections.
        const failed = new Set(Object.keys(discovered.errors));
        const known = new Set(discovered.connections.map((c) => c.id));
        for (const connection of this.snapshot.connections)
          if (failed.has(connection.source) && !known.has(connection.id))
            discovered.connections.push(connection);
        this.snapshot = discovered;
        const wanted = new Map<string, { entry: CatalogEntry; connection: ServiceConnection }>();
        const states: CapabilityState[] = [];
        for (const entry of this.options.modules.catalog.modules) {
          const unsupported =
            entry.platforms && !entry.platforms.includes(host.platform ?? process.platform)
              ? `Requires ${entry.platforms.join("/")}`
              : entry.requires?.filter((feature) => !host.features.has(feature)).join(", ");
          if (unsupported) {
            states.push({ module: entry.id, status: "unsupported", reason: unsupported });
            continue;
          }
          const connections = discovered.connections.filter(
            (connection) =>
              connection.provider === entry.provider &&
              (entry.auth
                ? connection.channel === entry.auth.channel &&
                  connection.kind !== "runtime" &&
                  entry.auth.acceptedKinds.includes(connection.kind)
                : connection.kind === "runtime" && connection.channel === entry.runtime),
          );
          if (!connections.length) {
            states.push({ module: entry.id, status: "missing", reason: "No matching service connection" });
            continue;
          }
          for (const connection of connections) {
            const state: CapabilityState = { module: entry.id, service: connection.id, status: "available" };
            if (
              preferences.excluded.some((key) =>
                [entry.capability, entry.id, `${entry.capability}@${connection.id}`].includes(key),
              )
            ) {
              state.status = "excluded";
            } else if (entry.modelInputExcludes?.some((input) => host.model?.input?.includes(input))) {
              state.status = "hidden";
              state.reason = "Current model already accepts this input";
            } else wanted.set(`${entry.id}@${connection.id}`, { entry, connection });
            states.push(state);
          }
        }
        const registry = this.options.registry;
        registry.setPreferred(preferences.preferred);
        for (const loaded of registry.list()) {
          if (wanted.has(loaded.id)) {
            registry.resume(loaded.id);
            continue;
          }
          registry.suspend(loaded.id);
          try {
            await registry.unload(loaded.id);
          } catch (error) {
            states.push({
              module: loaded.module.manifest.id,
              service: loaded.binding?.id,
              status: error instanceof EnhanceError && error.code === "MODULE_BUSY" ? "busy" : "error",
              reason: error instanceof Error ? error.message : String(error),
            });
          }
        }
        for (const [id, { entry, connection }] of wanted) {
          if (registry.get(id)) {
            registry.setBinding(id, {
              id: connection.id,
              label: connection.label,
              credentials: connection.credentials,
            });
            continue;
          }
          try {
            const module = await this.options.modules.load(entry.id);
            signal?.throwIfAborted();
            if (this.stopped) return;
            registry.load(module, this.options.services(entry, connection), {
              id: connection.id,
              label: connection.label,
              credentials: connection.credentials,
            });
          } catch (error) {
            signal?.throwIfAborted();
            const state = states.find((s) => s.module === entry.id && s.service === connection.id)!;
            state.status = "error";
            state.reason = error instanceof Error ? error.message : String(error);
          }
        }
        this.states = states;
      });
    this.syncing = operation;
    return operation;
  }
  async dispose(): Promise<void> {
    this.stopped = true;
    await this.syncing.catch(() => {});
    await this.options.registry.dispose();
  }
  describe(): string {
    return [
      ...this.snapshot.connections.map((c) => `${c.id} · ${c.label} · configured`),
      ...Object.entries(this.snapshot.errors).map(
        ([source, error]) => `${source}: discovery error: ${error}`,
      ),
      ...this.states.map(
        (s) =>
          `${s.module}${s.service ? ` @ ${s.service}` : ""}: ${s.status}${s.reason ? ` (${s.reason})` : ""}`,
      ),
    ].join("\n");
  }
}
