// packages/capabilities/fast/openai/src/manifest.ts
var manifest = {
  apiVersion: 1,
  id: "fast/openai",
  capability: "fast",
  provider: "openai",
  kind: "request-control",
  version: "0.2.0",
  requires: ["request-interception"]
};

// packages/transports/openai/src/model-support.ts
var SUPPORT = Object.freeze({
  "gpt-6-astra": { verbosity: true, originalImages: true, priority: true },
  "gpt-6-sol": { verbosity: true, originalImages: true, priority: true },
  "gpt-6-luna": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.6-sol": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.6-terra": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.6-luna": { verbosity: true, originalImages: true, priority: true },
  "gpt-daybreak-blue-latest": { verbosity: true, originalImages: true, priority: false },
  "gpt-daybreak-red-latest": { verbosity: true, originalImages: true, priority: false },
  "gpt-5.5": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.4": { verbosity: true, originalImages: true, priority: true },
  "gpt-5.4-mini": { verbosity: true, originalImages: true, priority: false },
  "gpt-5.2": { verbosity: true, originalImages: false, priority: false },
  "codex-auto-review": { verbosity: true, originalImages: true, priority: true }
});
function supportsModelOption(modelId, option) {
  return Object.hasOwn(SUPPORT, modelId) && SUPPORT[modelId][option];
}

// packages/capabilities/fast/openai/src/control.ts
function fastCreditMultiplier(modelId) {
  if (modelId === "gpt-5.4") return 2;
  if ([
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna"
  ].includes(modelId))
    return 2.5;
  return void 0;
}
var fastControl = {
  id: "fast",
  choices: ["off", "on"],
  description: "Priority tier: higher ChatGPT credit consumption",
  enabledNotice: "Fast requests service_tier=priority. ChatGPT credits: GPT-5.4 costs 2x; GPT-5.5/5.6/GPT-6 Astra/Sol/Luna cost 2.5x Standard where available. API token pricing is separate. Actual account billing/availability is backend-controlled.",
  formatValue(value, model) {
    const multiplier = fastCreditMultiplier(model.id);
    return value === "on" && multiplier ? `on(${multiplier}x)` : value;
  },
  supported: (model) => supportsModelOption(model.id, "priority"),
  transform: (payload, value) => value === "on" && payload.service_tier !== "priority" ? { ...payload, service_tier: "priority" } : payload
};

// packages/capabilities/fast/openai/src/index.ts
var index_default = { manifest, create: () => ({ control: fastControl }) };
export {
  index_default as default
};
