import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "verbosity/openai",
  capability: "verbosity",
  provider: "openai",
  kind: "request-control",
  version: "0.2.0",
  requires: ["request-interception"],
} satisfies ModuleManifest;
