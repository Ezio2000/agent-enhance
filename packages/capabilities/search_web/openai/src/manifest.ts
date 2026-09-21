import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "search_web/openai",
  capability: "search_web",
  provider: "openai",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "openai",
    channel: "codex",
    acceptedKinds: ["oauth"],
  },
} satisfies ModuleManifest;
