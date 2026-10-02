import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { VoiceClient } from "./client.ts";
import { VoiceArtifactStore } from "./artifacts.ts";
import { voiceTool } from "./tool.ts";
import { resolveMinimaxAuth } from "../../../../transports/minimax/src/auth.ts";
export default defineModule(definition, requirements, (services) => ({
  tool: voiceTool({
    artifacts: new VoiceArtifactStore(services.artifactRoot),
    client: (ctx) => new VoiceClient(() => resolveMinimaxAuth(ctx)),
  }),
}));
