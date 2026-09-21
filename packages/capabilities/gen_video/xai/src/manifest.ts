import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "gen_video/xai",
  capability: "gen_video",
  provider: "xai",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "xai",
    channel: "imagine",
    acceptedKinds: ["oauth"],
  },
} satisfies ModuleManifest;
