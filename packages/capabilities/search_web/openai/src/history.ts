import type { HistoryMessage } from "../../../../core/src/contracts.ts";
import { isRecord } from "../../../../transports/openai/src/http.ts";
import type { SearchInputMessage } from "./types.ts";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((x) => x.type === "text" && typeof x.text === "string")
    .map((x) => x.text as string)
    .join("\n");
}
export function recentSearchInput(messages: readonly HistoryMessage[]): SearchInputMessage[] | undefined {
  const visible = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && textContent(m.content),
  );
  const userIndices = visible.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  if (!userIndices.length) return;
  const end = userIndices.at(-1)!;
  const start = userIndices.at(-2) ?? end;
  let assistantBudget = 4000; // Conservative character cap, not a claim of exact tokenization.
  return visible.slice(start, end + 1).flatMap((m) => {
    let text = textContent(m.content);
    if (m.role === "assistant") {
      text = text.slice(0, assistantBudget);
      assistantBudget -= text.length;
    } else text = text.slice(0, 16000);
    if (!text) return [];
    return [
      {
        type: "message" as const,
        role: m.role as "user" | "assistant",
        content: [{ type: m.role === "user" ? ("input_text" as const) : ("output_text" as const), text }],
      },
    ];
  });
}
