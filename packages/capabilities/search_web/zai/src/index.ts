import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { ZaiWebClient } from "./client.ts";
import { RefStore } from "./refs.ts";
import { zaiWebTool, ZaiOutputStore } from "./tool.ts";
import { resolveZaiAuth } from "../../../../transports/zai/src/auth.ts";

export default {
  manifest,
  create: (services) => ({
    tool: zaiWebTool({
      artifacts: new ZaiOutputStore(services.artifactRoot),
      refs: new RefStore(),
      client: (ctx) => new ZaiWebClient(() => resolveZaiAuth(ctx)),
    }),
  }),
} satisfies CapabilityModule;
