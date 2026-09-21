import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { EnhanceError } from "./auth.ts";
import type {
  CapabilityModule,
  ExecutionContext,
  LifecycleEvent,
  ModuleInstance,
  ModuleServices,
  ToolDefinition,
  ToolResult,
} from "./contracts.ts";

export interface LoadedModule {
  module: CapabilityModule;
  instance: ModuleInstance;
}
const imageCommon = new Set(["prompt", "images", "model", "timeout_seconds"]);
const strings = (values: string[]) => Type.Unsafe<string>({ type: "string", enum: [...new Set(values)] });
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export class CapabilityRegistry {
  private readonly entries = new Map<string, LoadedModule>();
  private readonly pending = new Set<string>();
  readonly defaults: Record<string, string>;
  constructor(defaults: Record<string, string> = {}) {
    this.defaults = { ...defaults };
  }
  list(): LoadedModule[] {
    return [...this.entries.values()];
  }
  get(id: string): LoadedModule | undefined {
    return this.entries.get(id);
  }
  load(module: CapabilityModule, services: ModuleServices): void {
    const { manifest } = module;
    if (
      manifest.apiVersion !== 1 ||
      manifest.id !== `${manifest.capability}/${manifest.provider}` ||
      !/^[a-z][a-z0-9_]*$/.test(manifest.capability)
    )
      throw new EnhanceError("MODULE_CONTRACT", "Invalid module identity or API version.");
    if (this.entries.has(manifest.id)) return;
    if (manifest.platforms && !manifest.platforms.includes(process.platform))
      throw new EnhanceError("PLATFORM", `Module requires ${manifest.platforms.join(", ")}.`);
    const instance = module.create(services);
    if (manifest.kind === "tool" && (!instance.tool || instance.tool.name !== manifest.capability))
      throw new EnhanceError("MODULE_CONTRACT", "Tool name must match capability.");
    this.entries.set(manifest.id, { module, instance });
  }
  async unload(id: string): Promise<void> {
    if (this.pending.has(id))
      throw new EnhanceError("MODULE_BUSY", "Wait for the active call before unloading.");
    const entry = this.entries.get(id);
    await entry?.instance.dispose?.();
    this.entries.delete(id);
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
    const results = await Promise.allSettled(this.list().map((e) => e.instance.dispose?.()));
    this.entries.clear();
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
      if (entry.instance.tool) {
        const cap = entry.module.manifest.capability;
        groups.set(cap, [...(groups.get(cap) ?? []), entry]);
      }
    return [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cap, entries]) => this.merge(cap, entries));
  }
  private merge(capability: string, entries: LoadedModule[]): ToolDefinition<any, any> {
    const providers = entries.map((e) => e.module.manifest.provider);
    const first = entries[0]!.instance.tool!;
    const properties: Record<string, TSchema> = { provider: Type.Optional(strings(providers)) };
    const options: Record<string, TSchema> = {};
    for (const { module, instance } of entries) {
      const schema = instance.tool!.parameters;
      const specific: Record<string, TSchema> = {};
      const required: string[] = schema.required ?? [];
      for (const [key, field] of Object.entries(schema.properties as Record<string, TSchema>)) {
        if (capability === "gen_image" && !imageCommon.has(key))
          specific[key] = required.includes(key) ? field : Type.Optional(field);
        else if (!properties[key]) properties[key] = required.includes(key) ? field : Type.Optional(field);
      }
      if (Object.keys(specific).length)
        options[module.manifest.provider] = Type.Optional(
          Type.Object(specific, { additionalProperties: false }),
        );
    }
    if (capability === "gen_image") {
      properties.images = Type.Optional(
        Type.Array(
          Type.Object(
            {
              path: Type.Optional(Type.String({ minLength: 1 })),
              image_url: Type.Optional(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
          ),
          {
            minItems: 1,
            // A provider without reference-image support (e.g. minimax) contributes a floor of 1.
            maxItems: Math.max(
              ...entries.map(
                (e) =>
                  (e.instance.tool!.parameters.properties.images as { maxItems?: number } | undefined)
                    ?.maxItems ?? 1,
              ),
            ),
          },
        ),
      );
      properties.model = Type.Optional(
        strings(entries.flatMap((e) => e.instance.tool!.parameters.properties.model?.enum ?? [])),
      );
    }
    if (Object.keys(options).length)
      properties.options = Type.Optional(Type.Object(options, { additionalProperties: false }));
    const parameters = Type.Object(properties, { additionalProperties: false });
    return {
      name: capability,
      label: capability,
      description:
        `One ${capability} tool; loaded providers: ${providers.join(", ")}. Select provider explicitly or use the configured default. No cross-provider fallback. Provider-specific image parameters belong in options.<provider>.\n` +
        entries.map((e) => `[${e.module.manifest.provider}] ${e.instance.tool!.description}`).join("\n"),
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
        const provider =
          args.provider ?? this.defaults[capability] ?? (providers.length === 1 ? providers[0] : undefined);
        const entry = entries.find((e) => e.module.manifest.provider === provider);
        if (!entry)
          throw new EnhanceError(
            "PROVIDER_SELECTION",
            `Choose a loaded provider for ${capability}: ${providers.join(", ")}.`,
          );
        // Old schemas held by a host cannot execute an unloaded or replaced instance.
        const id = entry.module.manifest.id;
        if (this.entries.get(id) !== entry)
          throw new EnhanceError("STALE_TOOL", "Capability changed; use the refreshed tool schema.");
        const { provider: ignored, options: rawOptions, ...common } = args;
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
        const activeContext: ExecutionContext = { ...context, signal };
        this.pending.add(`${id}:${callId}`);
        this.pending.add(id);
        const normalize = (result: ToolResult<any>): ToolResult<any> => ({
          ...result,
          details: { ...result.details, version: 1, capability, provider },
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
          this.pending.delete(`${id}:${callId}`);
          if (![...this.pending].some((key) => key.startsWith(`${id}:`))) this.pending.delete(id);
        }
      },
    };
  }
}
