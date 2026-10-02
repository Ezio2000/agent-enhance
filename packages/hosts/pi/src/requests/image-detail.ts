import { isRecord } from "../../../../transports/openai/src/http.ts";
import { supportsRequestOption, matchesRequest } from "./context.ts";
import type { RequestControl } from "../../../../core/src/controls.ts";

function originalBlocks(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const blocks = value.map((block) => {
    if (!isRecord(block) || block.type !== "input_image" || block.detail === "original") return block;
    changed = true;
    return { ...block, detail: "original" };
  });
  return changed ? blocks : value;
}

export const imageDetailControl: RequestControl = {
  id: "image_detail",
  choices: ["off", "original"],
  description: "Request original image detail",
  enabledNotice:
    "Only changes input_image.detail. It does not disable host image resizing or recover original pixels from previews; read the saved original when needed.",
  supported: (model) =>
    model.input?.includes("image") === true && supportsRequestOption(model, "originalImages"),
  transform(payload, value, model) {
    if (!matchesRequest(payload, model)) return payload;
    if (value !== "original" || !Array.isArray(payload.input)) return payload;
    let changed = false;
    const input = payload.input.map((item) => {
      if (!isRecord(item)) return item;
      // Only visit actual Responses content blocks, never tool arguments, schemas or arbitrary JSON.
      const key =
        item.type === "function_call_output"
          ? "output"
          : item.type === "message" || item.role === "user"
            ? "content"
            : undefined;
      if (!key) return item;
      const blocks = originalBlocks(item[key]);
      if (blocks === item[key]) return item;
      changed = true;
      return { ...item, [key]: blocks };
    });
    return changed ? { ...payload, input } : payload;
  },
};
