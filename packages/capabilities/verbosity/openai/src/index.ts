import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { verbosityControl } from "./control.ts";
export default { manifest, create: () => ({ control: verbosityControl }) } satisfies CapabilityModule;
