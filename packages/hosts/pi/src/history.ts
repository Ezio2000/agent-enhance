import type { HistoryMessage } from "../../../core/src/contracts.ts";
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
/** Translate Pi transcript entries into a host-neutral, text-only history. */
export function piHistory(entries: readonly unknown[]): HistoryMessage[] {
  const messages: unknown[] = [];
  for (const entry of entries)
    if (object(entry)) {
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "compaction" && Array.isArray(entry.retainedTail))
        messages.push(...entry.retainedTail);
    }
  return messages.flatMap((message) => {
    if (!object(message) || (message.role !== "user" && message.role !== "assistant")) return [];
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(object)
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("\n")
          : "";
    return text ? [{ role: message.role, content: text }] : [];
  });
}
