import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { MODULE_API_VERSION } from "./module.ts";
import { EnhanceError } from "./auth.ts";
import type {
  CapabilityModule,
  ExecutionContext,
  LifecycleEvent,
  ModuleInstance,
  ModuleBinding,
  ModuleServices,
  ToolDefinition,
  ToolResult,
} from "./contracts.ts";

export interface LoadedModule {
  id: string;
  binding?: ModuleBinding;
  module: CapabilityModule;
  instance: ModuleInstance;
}
const strings = (values: string[]) => Type.Unsafe<string>({ type: "string", enum: [...new Set(values)] });
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export class CapabilityRegistry {
  private readonly entries = new Map<string, LoadedModule>();
  private readonly pending = new Map<string, number>();
  private readonly suspended = new Set<string>();
  private preferred: Readonly<Record<string, string>>;
  constructor(preferred: Readonly<Record<string, string>> = {}) {
    this.preferred = { ...preferred };
  }
  setPreferred(preferred: Readonly<Record<string, string>>): void {
    this.preferred = { ...preferred };
  }
  list(): LoadedModule[] {
    return [...this.entries.values()];
  }
  get(id: string): LoadedModule | undefined {
    return this.entries.get(id);
  }
  load(module: CapabilityModule, services: ModuleServices, binding?: ModuleBinding): void {
    const { manifest } = module;
    if (
      manifest.apiVersion !== MODULE_API_VERSION ||
      module.definition.id !== manifest.capability ||
      manifest.id !== `${manifest.capability}/${manifest.provider}` ||
      !/^[a-z][a-z0-9_]*$/.test(manifest.capability)
    )
      throw new EnhanceError("MODULE_CONTRACT", "Invalid module identity or API version.");
    const id = binding ? `${manifest.id}@${binding.id}` : manifest.id;
    if (this.entries.has(id)) return;
    if (manifest.platforms && !manifest.platforms.includes(process.platform))
      throw new EnhanceError("PLATFORM", `Module requires ${manifest.platforms.join(", ")}.`);
    const instance = module.create(services);
    if (!instance.tool || instance.tool.name !== manifest.capability)
      throw new EnhanceError("MODULE_CONTRACT", "Tool name must match capability.");
    this.entries.set(id, { id, module, instance, binding });
  }
  setBinding(id: string, binding: ModuleBinding): void {
    const entry = this.entries.get(id);
    if (!entry || entry.binding?.id !== binding.id)
      throw new EnhanceError("MODULE_CONTRACT", "Binding identity cannot change.");
    entry.binding = binding;
  }
  suspend(id: string): void {
    this.suspended.add(id);
  }
  resume(id: string): void {
    this.suspended.delete(id);
  }
  assertIdle(id: string): void {
    if (this.pending.has(id))
      throw new EnhanceError("MODULE_BUSY", "Wait for the active call before unloading.");
  }
  async unload(id: string): Promise<void> {
    this.assertIdle(id);
    const entry = this.entries.get(id);
    this.suspend(id);
    await entry?.instance.dispose?.();
    this.entries.delete(id);
    this.suspended.delete(id);
  }
  async lifecycle(event: LifecycleEvent, isIdle?: () => boolean): Promise<void> {
    const results = await Promise.allSettled(this.list().map((e) => e.instance.lifecycle?.(event, isIdle)));
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        `Lifecycle ${event} failed`,
      );
  }
  async dispose(): Promise<void> {
    for (const id of this.entries.keys()) this.suspend(id);
    const results = await Promise.allSettled(this.list().map((e) => e.instance.dispose?.()));
    this.entries.clear();
    this.suspended.clear();
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        "Module cleanup failed",
      );
  }
  tools(): ToolDefinition<any, any>[] {
    const groups = new Map<string, LoadedModule[]>();
    for (const entry of this.list())
      if (entry.instance.tool && !this.suspended.has(entry.id)) {
        const cap = entry.module.manifest.capability;
        groups.set(cap, [...(groups.get(cap) ?? []), entry]);
      }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cap, entries]) =>
        this.merge(
          cap,
          entries.sort(
            (a, b) =>
              a.module.manifest.provider.localeCompare(b.module.manifest.provider) ||
              (a.binding?.id ?? "").localeCompare(b.binding?.id ?? ""),
          ),
        ),
      );
  }
  private merge(capability: string, entries: LoadedModule[]): ToolDefinition<any, any> {
    const implementations = [...new Map(entries.map((e) => [e.module.manifest.provider, e])).values()];
    const providers = implementations.map((e) => e.module.manifest.provider);
    const definition = entries[0]!.module.definition;
    const first = entries[0]!.instance.tool!;
    const properties: Record<string, TSchema> = { provider: Type.Optional(strings(providers)) };
    if (entries.some((e) => e.binding))
      properties.service = Type.Optional(
        Type.Unsafe<string>({
          type: "string",
          enum: [...new Set(entries.map((e) => e.binding?.id ?? e.module.manifest.provider))],
          description:
            "Select an exact service connection: " +
            entries
              .map(
                (e) =>
                  `${e.binding?.id ?? e.module.manifest.provider} (${e.binding?.label ?? e.module.manifest.provider})`,
              )
              .join(", "),
        }),
      );
    const options: Record<string, TSchema> = {};
    const shared = new Map<string, { field: TSchema; required: boolean }[]>();
    for (const { module, instance } of implementations) {
      const schema = instance.tool!.parameters;
      const specific: Record<string, TSchema> = {};
      const required: string[] = schema.required ?? [];
      for (const [key, field] of Object.entries(schema.properties as Record<string, TSchema>)) {
        const common = definition.commonFields;
        if (common && !common.includes(key))
          specific[key] = required.includes(key) ? field : Type.Optional(field);
        else shared.set(key, [...(shared.get(key) ?? []), { field, required: required.includes(key) }]);
      }
      if (Object.keys(specific).length)
        options[module.manifest.provider] = Type.Optional(
          Type.Object(specific, { additionalProperties: false }),
        );
    }
    for (const [key, fields] of shared) {
      // Accept every loaded provider's field range; execution validates the selected provider.
      const variants = fields.map(({ field }) => {
        const { "~optional": ignored, ...schema } = field as TSchema & { "~optional"?: unknown };
        return Type.Unsafe(schema);
      });
      const distinct = [...new Map(variants.map((field) => [JSON.stringify(field), field])).values()];
      const field = distinct.length === 1 ? distinct[0]! : Type.Union(distinct);
      properties[key] =
        fields.length === implementations.length && fields.every((field) => field.required)
          ? field
          : Type.Optional(field);
    }
    Object.assign(
      properties,
      definition.composeParameters?.(implementations.map((e) => e.instance.tool!.parameters)),
    );
    if (Object.keys(options).length)
      properties.options = Type.Optional(Type.Object(options, { additionalProperties: false }));
    const parameters = Type.Object(properties, { additionalProperties: false });
    return {
      name: capability,
      label: definition.label,
      description:
        `Providers: ${providers.join(", ")}. Choose provider/service when several connections are available; a saved preference or a sole connection can be used implicitly. Failed calls never fall back.${definition.commonFields ? ` Provider-specific parameters go in options.<provider>.` : ""}\n` +
        implementations
          .map((e) => `[${e.module.manifest.provider}] ${e.instance.tool!.description}`)
          .join("\n"),
      promptSnippet: first.promptSnippet,
      promptGuidelines: [...new Set(entries.flatMap((e) => e.instance.tool!.promptGuidelines ?? []))],
      parameters,
      execute: async (callId, raw, signal, onUpdate, context) => {
        signal?.throwIfAborted();
        if (!Value.Check(parameters, raw))
          throw new EnhanceError(
            "INVALID_ARGUMENTS",
            "Arguments do not match the current loaded capability schema.",
          );
        const args = raw as Record<string, unknown>;
        const candidates = entries.filter(
          (e) => !args.provider || e.module.manifest.provider === args.provider,
        );
        const service = args.service ?? this.preferred[capability];
        const matches = service
          ? candidates.filter((e) => (e.binding?.id ?? e.module.manifest.provider) === service)
          : candidates;
        // An explicit provider may override an unrelated saved preference; an explicit service never falls back.
        const selectable = !args.service && args.provider && !matches.length ? candidates : matches;
        if (selectable.length !== 1)
          throw new EnhanceError(
            "PROVIDER_SELECTION",
            `Choose an exact provider/service for ${capability}; ${selectable.length ? "several connections match" : "selected connection is unavailable"}.`,
          );
        const entry = selectable[0]!;
        const provider = entry.module.manifest.provider;
        // Old schemas held by a host cannot execute an unloaded or replaced instance.
        const id = entry.id;
        if (this.entries.get(id) !== entry || this.suspended.has(id))
          throw new EnhanceError("STALE_TOOL", "Capability changed; use the refreshed tool schema.");
        const { provider: ignored, service: ignoredService, options: rawOptions, ...common } = args;
        const selectedOptions = object(rawOptions) ? rawOptions : {};
        if (Object.keys(selectedOptions).some((key) => key !== provider))
          throw new EnhanceError("PROVIDER_OPTIONS", "Only options for the selected provider are accepted.");
        const backendOptions = selectedOptions[String(provider)];
        const native = { ...common, ...(object(backendOptions) ? backendOptions : {}) };
        if (!Value.Check(entry.instance.tool!.parameters, native))
          throw new EnhanceError(
            "PROVIDER_ARGUMENTS",
            `Arguments are unsupported by ${provider}; check model and input limits.`,
          );
        const activeContext: ExecutionContext = {
          ...context,
          signal,
          credentials: entry.binding?.credentials ?? context.credentials,
        };
        this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
        const normalize = (result: ToolResult<any>): ToolResult<any> => ({
          ...result,
          details: {
            ...result.details,
            version: 1,
            capability,
            provider,
            ...(entry.binding ? { service: entry.binding.id } : {}),
          },
        });
        try {
          return normalize(
            await entry.instance.tool!.execute(
              callId,
              native,
              signal,
              onUpdate ? (r) => onUpdate(normalize(r)) : undefined,
              activeContext,
            ),
          );
        } finally {
          const remaining = (this.pending.get(id) ?? 1) - 1;
          if (remaining) this.pending.set(id, remaining);
          else this.pending.delete(id);
        }
      },
    };
  }
}
