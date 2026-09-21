import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "view_image/zai",
  capability: "view_image",
  provider: "zai",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "zai",
    channel: "coding-plan",
    acceptedKinds: ["api_key"],
  },
  /** Hosts skip registering this tool while the active model already accepts image input. */
  modelInputExcludes: ["image"],
} satisfies ModuleManifest;
