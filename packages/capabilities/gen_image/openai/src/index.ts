import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { ImageClient } from "./client.ts";
import { ImageArtifactStore } from "./artifacts.ts";
import { imageTool } from "./tool.ts";
import { resolveCodexAuth } from "../../../../transports/openai/src/auth.ts";
export default {
  manifest,
  create: (services) => ({
    tool: imageTool({
      artifacts: new ImageArtifactStore(services.artifactRoot),
      client: (ctx) => new ImageClient(() => resolveCodexAuth(ctx)),
      preview: services.preview,
    }),
  }),
} satisfies CapabilityModule;
