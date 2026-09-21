import { supportsModelOption } from "../../../../transports/openai/src/model-support.ts";
import type { RequestControl } from "../../../../core/src/controls.ts";

// ChatGPT-login credit multipliers, NOT API token prices or a measured bill.
// https://learn.chatgpt.com/docs/agent-configuration/speed (checked 2026-09-07)
export function fastCreditMultiplier(modelId: string): number | undefined {
  if (modelId === "gpt-5.4") return 2;
  if (["gpt-6-astra", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].includes(modelId))
    return 2.5;
  return undefined;
}
export const fastControl: RequestControl = {
  id: "fast",
  choices: ["off", "on"],
  description: "Priority tier: higher ChatGPT credit consumption",
  enabledNotice:
    "Fast requests service_tier=priority. ChatGPT credits: GPT-5.4 costs 2x; GPT-5.5/5.6/GPT-6 Astra cost 2.5x Standard. API token pricing is separate. Actual account billing/availability is backend-controlled.",
  formatValue(value, model) {
    const multiplier = fastCreditMultiplier(model.id);
    return value === "on" && multiplier ? `on(${multiplier}x)` : value;
  },
  supported: (model) => supportsModelOption(model.id, "priority"),
  transform: (payload, value) =>
    value === "on" && payload.service_tier !== "priority"
      ? { ...payload, service_tier: "priority" }
      : payload,
};
