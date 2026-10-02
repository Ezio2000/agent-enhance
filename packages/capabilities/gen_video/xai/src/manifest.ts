import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "xai",
  auth: {
    provider: "xai",
    channel: "imagine",
    acceptedKinds: ["oauth"],
  },
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
