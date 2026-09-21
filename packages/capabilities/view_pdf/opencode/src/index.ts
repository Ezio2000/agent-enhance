import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { pdfTool } from "./tool.ts";
export default { manifest, create: () => ({ tool: pdfTool() }) } satisfies CapabilityModule;
