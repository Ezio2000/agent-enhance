import test from "node:test";
import assert from "node:assert/strict";
import { recentSearchInput } from "../../../../packages/capabilities/search_web/openai/src/history.ts";

test("recent context excludes tools, reasoning, current commentary, and old turns", () => {
  const messages = [
    { role: "user", content: "old" },
    { role: "assistant", content: "old answer" },
    {
      role: "user",
      content: [
        { type: "text", text: "previous" },
        { type: "image", data: "sensitive" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret thought" },
        { type: "text", text: "answer" },
      ],
    },
    { role: "toolResult", content: "private file contents" },
    { role: "user", content: "current" },
    { role: "assistant", content: "current commentary" },
  ];
  const result = recentSearchInput(messages)!;
  assert.deepEqual(
    result.map((m) => m.content[0]?.text),
    ["previous", "answer", "current"],
  );
  assert.equal(recentSearchInput([{ role: "toolResult", content: "x" }]), undefined);
  assert.ok(
    JSON.stringify(
      recentSearchInput([
        { role: "user", content: "u" },
        { role: "assistant", content: "x".repeat(20000) },
        { role: "user", content: "new" },
      ]),
    ).length < 5000,
  );
});
