import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { VideoClient } from "./client.ts";
import { VideoArtifactStore } from "./artifacts.ts";
import { videoTool } from "./tool.ts";
import { resolveGrokAuth } from "../../../../transports/xai/src/auth.ts";
export default defineModule(definition, requirements, (services) => ({
  tool: videoTool({
    artifacts: new VideoArtifactStore(services.artifactRoot),
    client: (ctx) => new VideoClient(() => resolveGrokAuth(ctx)),
  }),
}));
