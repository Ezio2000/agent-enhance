import type { CapabilityDefinition } from "../../core/src/contracts.ts";
export const definition: CapabilityDefinition = {
  id: "search_web",
  label: "联网搜索",
  group: "Search",
  commonFields: ["search_query", "open"],
};
