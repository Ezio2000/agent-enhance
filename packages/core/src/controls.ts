import type { ModelInfo } from "./contracts.ts";
export interface RequestControl {
  id: string;
  choices: readonly string[];
  description: string;
  aliases?: Readonly<Record<string, string>>;
  enabledNotice?: string;
  formatValue?(value: string, model: ModelInfo): string;
  supported(model: ModelInfo): boolean;
  transform(payload: Record<string, unknown>, value: string): Record<string, unknown>;
}
export type ControlState = Record<string, string>;
export function transformControlledRequest(
  payload: unknown,
  model: ModelInfo | undefined,
  controls: readonly RequestControl[],
  state: ControlState,
): unknown {
  if (!model || model.provider !== "openai" || model.channel !== "codex" || model.api !== "codex-responses")
    return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let result = payload as Record<string, unknown>;
  if (!Array.isArray(result.input) || result.model !== model.id) return payload;
  for (const control of controls) {
    const value = state[control.id] ?? "off";
    if (value !== "off" && control.choices.includes(value) && control.supported(model))
      result = control.transform(result, value);
  }
  return result;
}
