import type { ModelInfo } from "./contracts.ts";
export interface RequestControl {
  id: string;
  choices: readonly string[];
  description: string;
  enabledNotice?: string;
  formatValue?(value: string, model: ModelInfo): string;
  supported(model: ModelInfo): boolean;
  transform(payload: Record<string, unknown>, value: string, model: ModelInfo): Record<string, unknown>;
}
export type ControlState = Record<string, string>;
export function transformControlledRequest(
  payload: unknown,
  model: ModelInfo | undefined,
  controls: readonly RequestControl[],
  state: ControlState,
): unknown {
  if (!model) return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let result = payload as Record<string, unknown>;
  for (const control of controls) {
    const value = state[control.id] ?? "off";
    if (value !== "off" && control.choices.includes(value) && control.supported(model))
      result = control.transform(result, value, model);
  }
  return result;
}
