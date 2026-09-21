import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "search_web/zai",
  capability: "search_web",
  provider: "zai",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "zai",
    channel: "coding-plan",
    acceptedKinds: ["api_key"],
  },
} satisfies ModuleManifest;
