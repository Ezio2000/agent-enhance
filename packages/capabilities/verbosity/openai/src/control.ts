import { isRecord } from "../../../../transports/openai/src/http.ts";
import { supportsModelOption } from "../../../../transports/openai/src/model-support.ts";
import type { RequestControl } from "../../../../core/src/controls.ts";

export const verbosityControl: RequestControl = {
  id: "verbosity",
  choices: ["off", "low", "medium", "high"],
  description: "Answer detail; off preserves the host's setting",
  supported: (model) => supportsModelOption(model.id, "verbosity"),
  transform(payload, value) {
    if (value === "off" || !["low", "medium", "high"].includes(value)) return payload;
    if (payload.text !== undefined && !isRecord(payload.text)) return payload;
    const text = isRecord(payload.text) ? payload.text : {};
    if (text.verbosity === value) return payload;
    return { ...payload, text: { ...text, verbosity: value } };
  },
};
