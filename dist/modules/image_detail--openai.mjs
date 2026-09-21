// packages/capabilities/image_detail/openai/src/manifest.ts
var manifest = {
  apiVersion: 1,
  id: "image_detail/openai",
  capability: "image_detail",
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

// packages/capabilities/image_detail/openai/src/control.ts
function originalBlocks(value) {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const blocks = value.map((block) => {
    if (!isRecord(block) || block.type !== "input_image" || block.detail === "original") return block;
    changed = true;
    return { ...block, detail: "original" };
  });
  return changed ? blocks : value;
}
var imageDetailControl = {
  id: "image_detail",
  choices: ["off", "original"],
  aliases: { on: "original" },
  description: "Request original image detail",
  enabledNotice: "Only changes input_image.detail. It does not disable host image resizing or recover original pixels from previews; read the saved original when needed.",
  supported: (model) => model.input?.includes("image") === true && supportsModelOption(model.id, "originalImages"),
  transform(payload, value) {
    if (value !== "original" || !Array.isArray(payload.input)) return payload;
    let changed = false;
    const input = payload.input.map((item) => {
      if (!isRecord(item)) return item;
      const key = item.type === "function_call_output" ? "output" : item.type === "message" || item.role === "user" ? "content" : void 0;
      if (!key) return item;
      const blocks = originalBlocks(item[key]);
      if (blocks === item[key]) return item;
      changed = true;
      return { ...item, [key]: blocks };
    });
    return changed ? { ...payload, input } : payload;
  }
};

// packages/capabilities/image_detail/openai/src/index.ts
var index_default = { manifest, create: () => ({ control: imageDetailControl }) };
export {
  index_default as default
};
