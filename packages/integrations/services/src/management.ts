import type { ServiceRuntime } from "./runtime.ts";
import type { Preferences, PreferenceStore } from "./preferences.ts";
export const serviceUsage =
  "services | status | refresh | prefer <capability> <service|auto> | exclude|include <capability> [service]";
/** Shared preference operations. Hosts supply their presentation and synchronization. */
export function manageServicePreferences<T extends Preferences>(
  args: string[],
  store: PreferenceStore<T>,
  runtime: ServiceRuntime,
): string | undefined {
  const [action, capability, service, ...rest] = args;
  if (action === "services")
    return (
      runtime.snapshot.connections.map((c) => `${c.id} · ${c.label}`).join("\n") ||
      "No service connections discovered. Sign in using the original provider application or configure an API key in the host/environment."
    );
  if (action === "status") {
    const p = store.load();
    return `${runtime.describe() || "No services discovered."}\nPreferred: ${JSON.stringify(p.preferred)}\nExcluded: ${JSON.stringify(p.excluded)}`;
  }
  if (!["prefer", "exclude", "include"].includes(action ?? "")) return;
  if (
    !capability ||
    rest.length ||
    !runtime.options.modules.catalog.modules.some((e) => e.capability === capability)
  )
    throw new Error(serviceUsage);
  if (
    service &&
    !(action === "prefer" && service === "auto") &&
    !runtime.snapshot.connections.some(
      (c) =>
        c.id === service &&
        runtime.options.modules.catalog.modules.some(
          (e) =>
            e.capability === capability &&
            e.provider === c.provider &&
            (e.auth?.channel ?? e.runtime) === c.channel,
        ),
    )
  )
    throw new Error(`Service ${service} does not provide ${capability}.`);
  if (action === "prefer") {
    if (!service) throw new Error(serviceUsage);
    store.update((p) => {
      const preferred = { ...p.preferred };
      if (service === "auto") delete preferred[capability];
      else preferred[capability] = service;
      return { ...p, preferred };
    });
    return `Preferred ${capability}: ${service}.`;
  }
  const key = service ? `${capability}@${service}` : capability;
  store.update((p) => ({
    ...p,
    excluded: action === "exclude" ? [...new Set([...p.excluded, key])] : p.excluded.filter((k) => k !== key),
  }));
  return `${action === "exclude" ? "Excluded" : "Included"} ${key}.`;
}
