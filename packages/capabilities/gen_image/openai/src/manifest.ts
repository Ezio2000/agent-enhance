import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "openai",
  auth: {
    provider: "openai",
    channel: "codex",
    acceptedKinds: ["oauth"],
  },
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
