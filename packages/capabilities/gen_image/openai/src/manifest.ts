import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "gen_image/openai",
  capability: "gen_image",
  provider: "openai",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "openai",
    channel: "codex",
    acceptedKinds: ["oauth"],
  },
} satisfies ModuleManifest;
