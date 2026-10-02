import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "opencode",
  auth: {
    provider: "opencode",
    channel: "go",
    acceptedKinds: ["api_key"],
  },
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
