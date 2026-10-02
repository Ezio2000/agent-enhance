import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const requirements = {
  provider: "openai",
  runtime: "chatgpt-desktop",
  platforms: ["darwin"],
  requires: ["approval", "task-settled"],
} satisfies Omit<ModuleManifest, "apiVersion" | "id" | "capability">;
