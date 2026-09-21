import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { ImageClient } from "./client.ts";
import { ImageArtifactStore } from "./artifacts.ts";
import { imageTool } from "./tool.ts";
import { resolveMinimaxAuth } from "../../../../transports/minimax/src/auth.ts";
export default {
  manifest,
  create: (services) => ({
    tool: imageTool({
      artifacts: new ImageArtifactStore(services.artifactRoot),
      client: (ctx) => new ImageClient(() => resolveMinimaxAuth(ctx)),
      preview: services.preview,
    }),
  }),
} satisfies CapabilityModule;
