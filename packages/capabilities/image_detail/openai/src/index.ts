import type { CapabilityModule } from "../../../../core/src/contracts.ts";
import { manifest } from "./manifest.ts";
import { imageDetailControl } from "./control.ts";
export default { manifest, create: () => ({ control: imageDetailControl }) } satisfies CapabilityModule;
