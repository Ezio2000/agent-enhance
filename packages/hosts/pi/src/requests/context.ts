import type { ModelInfo } from "../../../../core/src/contracts.ts";
import { supportsModelOption } from "../../../../transports/openai/src/model-support.ts";
export function supportsRequestOption(
  model: ModelInfo,
  option: "priority" | "verbosity" | "originalImages",
): boolean {
  return (
    model.provider === "openai" &&
    model.channel === "codex" &&
    model.api === "codex-responses" &&
    supportsModelOption(model.id, option)
  );
}
export function matchesRequest(payload: Record<string, unknown>, model: ModelInfo): boolean {
  return Array.isArray(payload.input) && payload.model === model.id;
}
