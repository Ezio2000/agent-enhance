import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "minimax",
  auth: {
    provider: "minimax",
    channel: "token-plan",
    acceptedKinds: ["api_key"],
  },
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
