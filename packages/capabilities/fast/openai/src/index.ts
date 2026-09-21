import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { fastControl } from "./control.ts";
export default { manifest, create: () => ({ control: fastControl }) } satisfies CapabilityModule;
