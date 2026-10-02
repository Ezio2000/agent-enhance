import { fastControl } from "./fast.ts";
import { verbosityControl } from "./verbosity.ts";
import { imageDetailControl } from "./image-detail.ts";
export const requestControls = [fastControl, verbosityControl, imageDetailControl];

import { EnhanceError } from "../../../../core/src/auth.ts";
import type { PiPreferences } from "../../../../integrations/services/src/preferences.ts";
export function verifyRequestPreferences(preferences: PiPreferences): void {
  for (const [id, value] of Object.entries(preferences.requests)) {
    const control = requestControls.find((c) => c.id === id);
    if (!control || !control.choices.includes(value))
      throw new EnhanceError(
        "CONFIG_INVALID",
        `Invalid request setting ${id}: choose ${control?.choices.join(" / ") ?? "a supported request control"}.`,
      );
  }
}
