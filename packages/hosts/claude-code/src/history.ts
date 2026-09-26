import { open } from "node:fs/promises";
import type { HistoryMessage } from "../../../core/src/contracts.ts";

const TAIL_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
/** Text-only user/assistant history from the tail of a Claude Code transcript (JSONL). */
export async function transcriptHistory(path: string | undefined): Promise<HistoryMessage[]> {
  if (!path) return [];
  let text: string;
  try {
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
  return claudeHistory(text.split("\n"));
}
export function claudeHistory(lines: readonly string[]): HistoryMessage[] {
  const result: HistoryMessage[] = [];
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!object(entry) || (entry.type !== "user" && entry.type !== "assistant")) continue;
    if (entry.isMeta || entry.isCompactSummary || entry.isSidechain) continue;
    const message = entry.message;
    if (!object(message) || (message.role !== "user" && message.role !== "assistant")) continue;
    const content =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(object)
              .filter((part) => part.type === "text" && typeof part.text === "string")
              .map((part) => part.text as string)
              .join("\n")
          : "";
    // Slash-command wrappers and local command output are harness text, not conversation.
    if (!content || /^\s*<(command-|local-command-)/.test(content)) continue;
    result.push({ role: message.role, content });
  }
  return result;
}
