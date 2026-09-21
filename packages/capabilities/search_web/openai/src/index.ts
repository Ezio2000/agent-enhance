import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { WebClient } from "./client.ts";
import { WebOutputStore } from "./output.ts";
import { webTool } from "./tool.ts";
import { resolveCodexAuth } from "../../../../transports/openai/src/auth.ts";
export default {
  manifest,
  create: (services) => ({
    tool: webTool({
      artifacts: new WebOutputStore(services.artifactRoot),
      client: (ctx) => new WebClient(() => resolveCodexAuth(ctx)),
    }),
  }),
} satisfies CapabilityModule;
