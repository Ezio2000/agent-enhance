import type { CapabilityDefinition, CapabilityModule, ModuleManifest } from "./contracts.ts";
export const MODULE_API_VERSION = 2;
export function defineModule(
  definition: CapabilityDefinition,
  manifest: Omit<ModuleManifest, "apiVersion" | "id" | "capability">,
  create: CapabilityModule["create"],
): CapabilityModule {
  return {
    definition,
    manifest: {
      ...manifest,
      apiVersion: MODULE_API_VERSION,
      id: `${definition.id}/${manifest.provider}`,
      capability: definition.id,
    },
    create,
  };
}
