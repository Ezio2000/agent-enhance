// packages/capabilities/verbosity/openai/src/manifest.ts
var manifest = {
  apiVersion: 1,
  id: "verbosity/openai",
  capability: "verbosity",
  provider: "openai",
  kind: "request-control",
  version: "0.2.0",
  requires: ["request-interception"]
};

// packages/transports/openai/src/http.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// packages/transports/openai/src/model-support.ts
var SUPPORT = Object.freeze({
  "gpt-6-astra": { verbosity: true, originalImages: true, priority: true },
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

// packages/capabilities/verbosity/openai/src/control.ts
var verbosityControl = {
  id: "verbosity",
  choices: ["off", "low", "medium", "high"],
  description: "Answer detail; off preserves the host's setting",
  supported: (model) => supportsModelOption(model.id, "verbosity"),
  transform(payload, value) {
    if (value === "off" || !["low", "medium", "high"].includes(value)) return payload;
    if (payload.text !== void 0 && !isRecord(payload.text)) return payload;
    const text = isRecord(payload.text) ? payload.text : {};
    if (text.verbosity === value) return payload;
    return { ...payload, text: { ...text, verbosity: value } };
  }
};

// packages/capabilities/verbosity/openai/src/index.ts
var index_default = { manifest, create: () => ({ control: verbosityControl }) };
export {
  index_default as default
};
