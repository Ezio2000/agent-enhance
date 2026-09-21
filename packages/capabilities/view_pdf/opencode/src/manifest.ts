import type { ModuleManifest } from "../../../../core/src/contracts.ts";
export const manifest = {
  apiVersion: 1,
  id: "view_pdf/opencode",
  capability: "view_pdf",
  provider: "opencode",
  kind: "tool",
  version: "0.2.0",
  auth: {
    provider: "opencode",
    channel: "go",
    acceptedKinds: ["api_key"],
  },
} satisfies ModuleManifest;
