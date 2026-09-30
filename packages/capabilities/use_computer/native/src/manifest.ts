import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "use_computer/native",
  capability: "use_computer",
  provider: "native",
  kind: "tool",
  version: "0.4.5",
  platforms: ["darwin"],
  requires: ["task-settled"],
} satisfies ModuleManifest;
