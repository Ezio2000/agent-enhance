import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { VoiceClient } from "./client.ts";
import { VoiceArtifactStore } from "./artifacts.ts";
import { voiceTool } from "./tool.ts";
import { resolveMinimaxAuth } from "../../../../transports/minimax/src/auth.ts";
export default {
  manifest,
  create: (services) => ({
    tool: voiceTool({
      artifacts: new VoiceArtifactStore(services.artifactRoot),
      client: (ctx) => new VoiceClient(() => resolveMinimaxAuth(ctx)),
    }),
  }),
} satisfies CapabilityModule;
