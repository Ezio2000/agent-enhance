import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "zai",
  auth: {
    provider: "zai",
    channel: "coding-plan",
    acceptedKinds: ["api_key"],
  },
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
