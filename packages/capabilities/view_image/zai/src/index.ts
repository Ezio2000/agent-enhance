import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { VisionClient } from "./client.ts";
import { viewImageTool } from "./tool.ts";
import { resolveZaiAuth } from "../../../../transports/zai/src/auth.ts";

export default defineModule(definition, requirements, () => ({
  tool: viewImageTool({
    client: (ctx) => new VisionClient(() => resolveZaiAuth(ctx)),
  }),
}));
