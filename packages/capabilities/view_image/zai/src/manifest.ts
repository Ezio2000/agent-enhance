import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "zai",
  auth: {
    provider: "zai",
    channel: "coding-plan",
    acceptedKinds: ["api_key"],
  },
  /** Hosts skip registering this tool while the active model already accepts image input. */
  modelInputExcludes: ["image"],
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
