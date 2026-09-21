import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { VideoClient } from "./client.ts";
import { VideoArtifactStore } from "./artifacts.ts";
import { videoTool } from "./tool.ts";
import { resolveGrokAuth } from "../../../../transports/xai/src/auth.ts";
export default {
  manifest,
  create: (services) => ({
    tool: videoTool({
      artifacts: new VideoArtifactStore(services.artifactRoot),
      client: (ctx) => new VideoClient(() => resolveGrokAuth(ctx)),
    }),
  }),
} satisfies CapabilityModule;
