import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "../../../../core/src/contracts.ts";
import { ToolExecutionError } from "../../../../core/src/contracts.ts";
import type { ComputerSession } from "./session.ts";
import type { ComputerOutput } from "./output.ts";
export const ComputerSchema = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: 32000,
      description:
        "JavaScript using computer and print. All APIs are async; use var for persistent bindings. First call: print(await computer.getState()); then var app=await computer.getApp(bundleId); var win=await app.getWindow(observedId); await win.pressKey(keys,options). Input methods belong to Window, not computer. Permissions are in state.permissions.",
    }),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Short description of this desktop operation.",
      }),
    ),
    timeout_seconds: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 120,
        description: "Whole-call deadline including startup and system permissions; default 60 seconds.",
      }),
    ),
  },
  { additionalProperties: false },
);
export function computerTool(
  session: ComputerSession,
  output: ComputerOutput,
): ToolDefinition<typeof ComputerSchema> {
  return {
    name: "use_computer",
    label: "Computer Use",
    description:
      "Operate macOS apps with JavaScript. First call: print(await computer.getState()); read local API docs. print(...values) keeps all arguments. App/window APIs use exact observed IDs. For chats, observe({depth:60}), search all elements, and prefer an existing conversation's AXPress ancestor over global search. observe retries missing embedded web trees and reports webContent readiness. Prefer verified replaceText/selectAll/selectText and AX actions. Default isolated-only refuses foreground/HID and the user's active input target. ISOLATION_VIOLATION is a post-action focus change: read state/windows/observe and verify effects. If focusRecoveryAvailable:true, call computer.restoreUserFocus(), then observe again before further input. Never replay input or change global settings to recover a read. The host alone may enable shared input. Directed background keys need an observed element; coordinates use a logical cursor with explicit modifiers. withKeys releases through the original target. Optional expect verifies value/selectedRange; dispatched alone never proves an app effect. No foreground fallback, hidden Command modifier or automatic replay. Complete failure diagnostics/screenshots are retained. computer.showImage(path) displays saved failure PNGs without replay.",
    promptSnippet:
      "Operate native Mac applications with JavaScript, isolated background semantics and directed input",
    promptGuidelines: [
      "Prefer APIs/CLI when available; use use_computer for desktop UI tasks. Observe before acting and verify dispatched effects.",
    ],
    parameters: ComputerSchema,
    async execute(_callId, args, signal, update, ctx) {
      if (!Value.Check(ComputerSchema, args)) throw new Error("Invalid use_computer arguments.");
      signal?.throwIfAborted();
      update?.({
        content: [{ type: "text", text: args.title ?? "Using the desktop…" }],
        details: { status: "in_progress" },
      });
      const result = await session.run({
        code: args.code,
        timeoutMs: (args.timeout_seconds ?? 60) * 1000,
        sessionId: ctx.sessionId,
        signal,
      });
      const formatted = await output.format(ctx.sessionId, result);
      if (result.error) throw new ToolExecutionError(formatted);
      return formatted;
    },
  };
}
