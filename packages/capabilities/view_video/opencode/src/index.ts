import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { videoTool } from "./tool.ts";
export default { manifest, create: () => ({ tool: videoTool() }) } satisfies CapabilityModule;
