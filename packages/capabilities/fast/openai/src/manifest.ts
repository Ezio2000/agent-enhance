import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "fast/openai",
  capability: "fast",
  provider: "openai",
  kind: "request-control",
  version: "0.2.0",
  requires: ["request-interception"],
} satisfies ModuleManifest;
