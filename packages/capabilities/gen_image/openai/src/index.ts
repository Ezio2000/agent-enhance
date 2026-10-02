import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { ImageClient } from "./client.ts";
import { ImageArtifactStore } from "./artifacts.ts";
import { imageTool } from "./tool.ts";
import { resolveCodexAuth } from "../../../../transports/openai/src/auth.ts";
export default defineModule(definition, requirements, (services) => ({
  tool: imageTool({
    artifacts: new ImageArtifactStore(services.artifactRoot),
    client: (ctx) => new ImageClient(() => resolveCodexAuth(ctx)),
    preview: services.preview,
  }),
}));
