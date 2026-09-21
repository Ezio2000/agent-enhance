import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "view_video/opencode",
  capability: "view_video",
  provider: "opencode",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "opencode",
    channel: "go",
    acceptedKinds: ["api_key"],
  },
} satisfies ModuleManifest;
