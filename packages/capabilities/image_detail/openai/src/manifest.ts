import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "image_detail/openai",
  capability: "image_detail",
  provider: "openai",
  kind: "request-control",
  version: "0.2.0",
  requires: ["request-interception"],
} satisfies ModuleManifest;
