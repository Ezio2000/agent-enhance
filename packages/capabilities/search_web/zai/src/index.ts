import { requirements } from "./manifest.ts";
import { definition } from "../../definition.ts";
import { defineModule } from "../../../../core/src/module.ts";
import { ZaiWebClient } from "./client.ts";
import { RefStore } from "./refs.ts";
import { zaiWebTool, ZaiOutputStore } from "./tool.ts";
import { resolveZaiAuth } from "../../../../transports/zai/src/auth.ts";

export default defineModule(definition, requirements, (services) => ({
  tool: zaiWebTool({
    artifacts: new ZaiOutputStore(services.artifactRoot),
    refs: new RefStore(),
    client: (ctx) => new ZaiWebClient(() => resolveZaiAuth(ctx)),
  }),
}));
