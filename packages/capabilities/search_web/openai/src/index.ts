import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { WebClient } from "./client.ts";
import { WebOutputStore } from "./output.ts";
import { webTool } from "./tool.ts";
import { resolveCodexAuth } from "../../../../transports/openai/src/auth.ts";
export default defineModule(definition, requirements, (services) => ({
  tool: webTool({
    artifacts: new WebOutputStore(services.artifactRoot),
    client: (ctx) => new WebClient(() => resolveCodexAuth(ctx)),
  }),
}));
