import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "use_computer/openai",
  capability: "use_computer",
  provider: "openai",
  kind: "tool",
  version: "0.2.0",
  platforms: ["darwin"],
  requires: ["approval", "task-settled"],
} satisfies ModuleManifest;
