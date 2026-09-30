import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolDefinition } from "../../../../core/src/contracts.ts";
import type { ComputerSession } from "./session.ts";
import type { ComputerOutput } from "./output.ts";
export const ComputerSchema = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: 32000,
      description:
        "JavaScript using computer and print. Start with await computer.getState(); full API docs are returned on first execution.",
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
      "Operate native macOS apps through the independent Agent Enhance runtime using JavaScript. Use computer.getState(), computer.getApp(bundleId), app.listWindows(), app.getWindow(windowId), then window.observe(). Full API documentation is emitted on first use; computer.help() returns it again. Prefer var for reusable bindings. print(value) emits output; window.screenshot() emits PNG and returns coordinate metadata. Only native UI is supported, including browsers through their macOS UI.\n" +
      "Default background delivery uses AX semantics; foreground input must explicitly set {mode:'foreground'}. Background keyboard needs an observed element; use setValue for writable controls. Raw key holds, pointer input, dragging and modifier-mouse combinations require foreground. withKeys(keys, asyncCallback, {mode:'foreground'}) scopes modifier keys. Observe fresh UI, use exact returned IDs, and never replay failed actions automatically.\n" +
      "Bindings persist until the task settles/reset, while held keys/buttons are released at every call boundary. Timeout/cancellation stops the script and clears queued actions without undoing completed effects. Native input can be accepted/dispatched without confirmed application effect: observe to verify. Returns bounded text and up to four PNG screenshots (24 MiB total), saved locally.",
    promptSnippet:
      "Operate native Mac applications with JavaScript, background AX actions and explicit foreground keyboard/mouse combinations",
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
      if (result.error)
        throw new Error(
          formatted.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n"),
        );
      return formatted;
    },
  };
}
