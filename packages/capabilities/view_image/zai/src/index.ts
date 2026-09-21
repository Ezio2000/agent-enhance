import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { VisionClient } from "./client.ts";
import { viewImageTool } from "./tool.ts";
import { resolveZaiAuth } from "../../../../transports/zai/src/auth.ts";

export default {
  manifest,
  create: () => ({
    tool: viewImageTool({
      client: (ctx) => new VisionClient(() => resolveZaiAuth(ctx)),
    }),
  }),
} satisfies CapabilityModule;
