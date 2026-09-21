import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "gen_image/minimax",
  capability: "gen_image",
  provider: "minimax",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "minimax",
    channel: "token-plan",
    acceptedKinds: ["api_key"],
  },
} satisfies ModuleManifest;
