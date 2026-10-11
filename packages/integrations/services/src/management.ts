import type { ServiceRuntime } from "./runtime.ts";
import type { Preferences, PreferenceStore } from "./preferences.ts";
import { defaultServiceOrder, providerOrder } from "./defaults.ts";
export const serviceUsage =
  "status | services | refresh | prefer <capability> [service|auto] | exclude|include <capability> [service]";
/** Aligned help for the shared commands followed by host-specific `[usage, purpose]` rows. */
export function serviceHelp(command: string, extra: readonly (readonly [string, string])[] = []): string {
  const rows = [
    ["status", "capability overview: which connection each tool uses"],
    ["services", "discovered connections and the capabilities they provide"],
    ["refresh", "re-scan credentials and update live tools"],
    [
      "prefer <capability> [service|auto]",
      "choose the connection a capability uses (no service: list choices)",
    ],
    ["exclude <capability> [service]", "hide a capability, or only one of its connections"],
    ["include <capability> [service]", "undo the matching exclude"],
    ...extra,
  ];
  const width = Math.max(...rows.map(([usage]) => usage.length));
  return rows.map(([usage, purpose]) => `${command} ${usage.padEnd(width)}  ${purpose}`).join("\n");
}

// Where each provider's credentials come from; shown when a capability has no connection.
const setup: Readonly<Record<string, string>> = {
  openai: "run `codex login` (or Pi /login → openai-codex)",
  xai: "sign in with Pi /login → xai",
  minimax: "set MINIMAX_CN_API_KEY / MINIMAX_API_KEY (or Pi /login → minimax-cn)",
  zai: "set ZAI_API_KEY / ZAI_CODING_CN_API_KEY (or Pi /login → zai)",
  opencode: "set OPENCODE_API_KEY, sign in to OpenCode (or Pi /login → opencode-go)",
};
const runtimeSetup: Readonly<Record<string, string>> = {
  "chatgpt-desktop": "install the ChatGPT desktop app",
};

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}
/** Close spellings or containing names, e.g. `image` → gen_image, view_image. */
export function suggest(input: string, options: readonly string[]): string {
  const needle = input.toLowerCase();
  const close = options.filter((o) => o.includes(needle) || distance(needle, o) <= 2);
  return close.length ? ` Did you mean ${close.slice(0, 3).join(" or ")}?` : "";
}

const capabilitiesOf = (runtime: ServiceRuntime) => [
  ...new Set(runtime.options.modules.catalog.modules.map((e) => e.capability)),
];
const statesOf = (runtime: ServiceRuntime, capability: string) =>
  runtime.states.filter((s) => s.module.startsWith(`${capability}/`));
/** Connections that implement a capability, excluded ones included, in automatic-selection order. */
export function capabilityServices(runtime: ServiceRuntime, capability: string): string[] {
  const ids = new Set(
    statesOf(runtime, capability).flatMap((s) =>
      s.service && s.status !== "unsupported" ? [s.service] : [],
    ),
  );
  return defaultServiceOrder(
    capability,
    runtime.snapshot.connections.filter((c) => ids.has(c.id)),
  );
}
const isExcluded = (preferences: Preferences, capability: string, service: string) =>
  preferences.excluded.some((key) => [capability, `${capability}@${service}`].includes(key));

export interface CapabilitySummary {
  capability: string;
  label: string;
  /** Connection used when a call omits provider/service. */
  service?: string;
  via?: "service" | "preferred" | "default" | "sole";
  alternatives: number;
  /** ready: callable; off: excluded/hidden/unsupported by choice or host; problem: needs action. */
  state: "ready" | "off" | "problem";
  note?: string;
}
/** Capability-centric view of the runtime: what a call would use now, or why nothing is available. */
export function summarize(
  runtime: ServiceRuntime,
  preferences: Preferences,
  command: string,
): CapabilitySummary[] {
  const catalog = runtime.options.modules.catalog.modules;
  return capabilitiesOf(runtime).map((capability) => {
    const label = catalog.find((e) => e.capability === capability)!.label;
    const states = statesOf(runtime, capability);
    const active = states.filter((s) => s.status === "available");
    const route = runtime.options.registry.route(capability);
    const saved = preferences.preferred[capability];
    const base = { capability, label, alternatives: Math.max(0, active.length - 1) };
    if ("entry" in route) {
      const service = route.entry.binding?.id ?? route.entry.module.manifest.provider;
      return { ...base, service, via: route.via, state: "ready" };
    }
    if (preferences.excluded.includes(capability))
      return { ...base, state: "off", note: `excluded · ${command} include ${capability}` };
    if (saved && active.length)
      return {
        ...base,
        state: "problem",
        note: `saved preference ${saved} is unavailable, so calls fail · ${command} prefer ${capability} auto`,
      };
    const failed = states.find((s) => s.status === "error" || s.status === "busy");
    if (failed) return { ...base, state: "problem", note: `${failed.status}: ${failed.reason ?? "unknown"}` };
    const hidden = states.find((s) => s.status === "hidden");
    if (hidden) return { ...base, state: "off", note: `hidden · ${hidden.reason}` };
    if (states.some((s) => s.status === "excluded"))
      return { ...base, state: "off", note: `all connections excluded · ${command} include ${capability}` };
    const rank = (module: string) => {
      const index = providerOrder(capability).indexOf(module.split("/")[1]!);
      return index < 0 ? Infinity : index;
    };
    const missing = states
      .filter((s) => s.status === "missing")
      .sort((a, b) => rank(a.module) - rank(b.module));
    if (missing.length) {
      const hints = [
        ...new Set(
          missing.map((s) => {
            const entry = catalog.find((e) => e.id === s.module)!;
            return (
              (entry.runtime && runtimeSetup[entry.runtime]) ??
              setup[entry.provider] ??
              `configure ${entry.provider}`
            );
          }),
        ),
      ];
      return { ...base, state: "problem", note: `no connection · ${hints.join("; or ")}` };
    }
    const unsupported = states.find((s) => s.status === "unsupported");
    return { ...base, state: "off", note: `unsupported here · ${unsupported?.reason ?? "unknown"}` };
  });
}
const mark = { ready: "✓", off: "–", problem: "✗" } as const;
export function serviceOverview(runtime: ServiceRuntime, preferences: Preferences, command: string): string {
  const rows = summarize(runtime, preferences, command);
  const width = Math.max(...rows.map((r) => r.capability.length));
  const lines = [
    `Capabilities (${rows.filter((r) => r.state === "ready").length}/${rows.length} ready):`,
    ...rows.map((r) => {
      const detail =
        r.state === "ready"
          ? [
              r.service,
              r.via === "preferred" ? "preferred" : r.via === "default" ? "default" : undefined,
              r.alternatives ? `+${r.alternatives} alternative${r.alternatives > 1 ? "s" : ""}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")
          : r.note;
      return `  ${mark[r.state]} ${r.capability.padEnd(width)}  ${detail}`;
    }),
  ];
  const count = runtime.snapshot.connections.length;
  lines.push(
    count
      ? `Connections: ${count} discovered (${command} services for details).`
      : "No service connections discovered. Sign in with the provider's own app (e.g. `codex login`, Pi /login) or set its API key environment variable, then run refresh.",
  );
  const errors = Object.entries(runtime.snapshot.errors);
  if (errors.length)
    lines.push("Discovery errors:", ...errors.map(([source, error]) => `  ${source}: ${error}`));
  return lines.join("\n");
}
export function serviceList(runtime: ServiceRuntime): string {
  const provides = (id: string) =>
    [
      ...new Set(
        runtime.states
          .filter((s) => s.service === id && s.status !== "unsupported")
          .map((s) => s.module.split("/")[0]!),
      ),
    ].sort();
  const lines = runtime.snapshot.connections.map((c) => {
    const capabilities = provides(c.id);
    return `${c.id} · ${c.label}${capabilities.length ? `\n    provides: ${capabilities.join(", ")}` : ""}`;
  });
  if (!lines.length)
    lines.push(
      "No service connections discovered. Sign in using the original provider application or configure an API key in the host/environment.",
    );
  const errors = Object.entries(runtime.snapshot.errors);
  if (errors.length)
    lines.push("Discovery errors:", ...errors.map(([source, error]) => `  ${source}: ${error}`));
  return lines.join("\n");
}
/** Shared preference operations. Hosts supply their presentation and synchronization. */
export function manageServicePreferences<T extends Preferences>(
  args: string[],
  store: PreferenceStore<T>,
  runtime: ServiceRuntime,
  command = "",
): string | undefined {
  const prefix = command ? `${command} ` : "";
  const [action, capability, service, ...rest] = args;
  if (action === "services" && args.length === 1) return serviceList(runtime);
  if (action === "status" && args.length === 1) return serviceOverview(runtime, store.load(), command);
  if (!["prefer", "exclude", "include"].includes(action ?? "")) return;
  const capabilities = capabilitiesOf(runtime);
  if (!capability)
    throw new Error(
      `Name a capability: ${prefix}${action} <capability>. Capabilities: ${capabilities.join(", ")}.`,
    );
  if (rest.length) throw new Error(`Too many arguments. Usage: ${prefix}${action} <capability> [service].`);
  if (!capabilities.includes(capability))
    throw new Error(
      `Unknown capability "${capability}".${suggest(capability, capabilities)} Capabilities: ${capabilities.join(", ")}.`,
    );
  const services = capabilityServices(runtime, capability);
  if (service && !(action === "prefer" && service === "auto") && !services.includes(service))
    throw new Error(
      `Service ${service} does not provide ${capability}.${suggest(service, services)} ${
        services.length
          ? `Services for ${capability}: ${services.join(", ")}.`
          : `No discovered connection provides ${capability}; see ${prefix}status.`
      }`,
    );
  const preferences = store.load();
  if (action === "prefer") {
    if (!service) {
      const route = runtime.options.registry.route(capability);
      const current =
        "entry" in route ? (route.entry.binding?.id ?? route.entry.module.manifest.provider) : undefined;
      if (!services.length) return `No discovered connection provides ${capability}; see ${prefix}status.`;
      return [
        current
          ? `${capability} currently uses ${current} (${preferences.preferred[capability] ? "saved preference" : "automatic"}). Choose:`
          : `Choose a connection for ${capability}:`,
        ...services.map(
          (id) =>
            `  ${prefix}prefer ${capability} ${id}${id === current ? "   ← current" : ""}${isExcluded(preferences, capability, id) ? "   (excluded)" : ""}`,
        ),
        `  ${prefix}prefer ${capability} auto${preferences.preferred[capability] ? "" : "   ← current"}`,
      ].join("\n");
    }
    store.update((p) => {
      const preferred = { ...p.preferred };
      if (service === "auto") delete preferred[capability];
      else preferred[capability] = service;
      return { ...p, preferred };
    });
    if (service === "auto") return `Preferred ${capability}: auto (built-in order chooses the connection).`;
    return isExcluded(preferences, capability, service)
      ? `Preferred ${capability}: ${service}. It is excluded, so calls fail until ${prefix}include ${capability} ${service}.`
      : `Preferred ${capability}: ${service}.`;
  }
  const key = service ? `${capability}@${service}` : capability;
  if (action === "exclude") {
    if (preferences.excluded.includes(key)) return `${key} is already excluded.`;
    store.update((p) => ({ ...p, excluded: [...new Set([...p.excluded, key])] }));
    return service
      ? `Excluded ${key}. ${capability} keeps its other connections.`
      : `Excluded ${capability}. The tool is hidden until ${prefix}include ${capability}.`;
  }
  if (!preferences.excluded.includes(key)) {
    const partial = service
      ? []
      : preferences.excluded.flatMap((k) =>
          k.startsWith(`${capability}@`) ? [k.slice(capability.length + 1)] : [],
        );
    return partial.length
      ? `${capability} is not excluded as a whole; only these connections are: ${partial.join(", ")}. Restore one with ${prefix}include ${capability} <service>.`
      : `${key} is not excluded; nothing changed.`;
  }
  store.update((p) => ({ ...p, excluded: p.excluded.filter((k) => k !== key) }));
  return `Included ${key}.`;
}
