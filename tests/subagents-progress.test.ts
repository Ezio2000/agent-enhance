import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { runSubagent } from "../packages/hosts/pi/src/subagents/runner.ts";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { Subagents } from "../packages/hosts/pi/src/subagents/index.ts";

const model = { provider: "test", id: "text", name: "Test", input: ["text"], reasoning: false };
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(runner: typeof runSubagent) {
  const messages: any[] = [];
  let render: any;
  const pi = {
    registerMessageRenderer: (_name: string, fn: any) => {
      render = fn;
    },
    getActiveTools: () => ["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"],
    sendMessage: (message: any, settings: any) => messages.push({ message, settings }),
  } as unknown as ExtensionAPI;
  const agents = new Subagents(pi, new CapabilityRegistry(), runner);
  agents.setEnabled(true);
  let sessionId = "one";
  agents.startSession(sessionId);
  const ctx = {
    model,
    thinkingLevel: "off",
    modelRegistry: { getAvailable: () => [model] },
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "anchor",
      getBranch: () => [{ id: "anchor" }],
    },
    hasUI: false,
  } as unknown as ExtensionContext;
  const tools = new Map(agents.tools().map((tool) => [tool.name, tool]));
  const execute = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await tools.get(name)!.execute("test", args, undefined, undefined, ctx);
    let json: any;
    const text = result.content.find((item) => item.type === "text")?.text;
    if (text)
      try {
        json = JSON.parse(text);
      } catch {
        /* call_subagents returns prose */
      }
    return { ...result, json };
  };
  return {
    agents,
    messages,
    render,
    execute,
    switchSession: () => {
      sessionId = "two";
      agents.startSession(sessionId);
    },
  };
}

test("view_subagents tracks running phase, usage and final result; final card triggers follow-up", async () => {
  let finish!: () => void;
  let update!: NonNullable<Parameters<typeof runSubagent>[7]>;
  const runner: typeof runSubagent = async (
    _task,
    index,
    m,
    _thinking,
    _registry,
    _parent,
    _signal,
    report,
  ) => {
    update = report!;
    report?.({
      phase: "tool",
      tool: "search_web",
      turns: 2,
      usage: { input: 123, output: 45, cost: 0.002 },
      recent: [{ source: "tool", tool: "search_web", text: "Found 3 pages" }],
    });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      index,
      model: `${m.provider}/${m.id}`,
      status: "completed",
      text: "Found sources and summarized findings.",
      turns: 3,
      usage: { input: 300, output: 80, cost: 0.01 },
    };
  };
  const h = setup(runner);
  const call = await h.execute("call_subagents", { tasks: [{ context: "Find sources" }] });
  const { batchId, taskIds } = call.details;
  await flush();
  const list = (await h.execute("view_subagents")).json;
  assert.equal(list.batches[0].batchId, batchId);
  const batch = (await h.execute("view_subagents", { batchId })).json;
  assert.equal(batch.tasks[0].phase, "tool");
  assert.equal(batch.tasks[0].current_tool, "search_web");
  assert.equal(batch.tasks[0].usage.input, 123);
  assert.deepEqual(batch.tasks[0].recent_output, [
    { source: "tool", tool: "search_web", text: "Found 3 pages" },
  ]);
  assert.equal(batch.tasks[0].turns, 2);
  assert.equal(h.messages.length, 0);
  const theme = {
    fg: (_key: string, text: string) => text,
    bg: (_key: string, text: string) => text,
    bold: (text: string) => text,
  };
  const tool = h.agents.tools().find((item) => item.name === "call_subagents")!;
  let invalidations = 0;
  const context = {
    state: {},
    invalidate: () => {
      invalidations++;
    },
  } as any;
  const liveCard = () =>
    tool.renderResult!(call, { expanded: true } as any, theme as any, context)
      .render(100)
      .join("\n");
  assert.match(liveCard(), /0\/1 completed/);
  assert.match(liveCard(), /123 in \/ 45 out/);
  assert.match(liveCard(), /Found 3 pages/);
  update({
    phase: "thinking",
    turns: 2,
    usage: { input: 200, output: 60, cost: 0.003 },
    recent: [{ source: "assistant", text: "Working on summary" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(invalidations > 0);
  assert.match(liveCard(), /200 in \/ 60 out/);
  assert.match(liveCard(), /Working on summary/);
  finish();
  await flush();
  const task = (await h.execute("view_subagents", { id: taskIds[0] })).json.task;
  assert.equal(task.status, "completed");
  assert.equal(task.result, "Found sources and summarized findings.");
  assert.match(liveCard(), /1\/1 completed/);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].settings, { triggerTurn: true, deliverAs: "followUp" });
  const card = h
    .render(
      h.messages[0].message,
      { expanded: false, outputPad: 0 },
      {
        fg: (_key: string, text: string) => text,
        bg: (_key: string, text: string) => text,
        bold: (text: string) => text,
      },
    )
    .render(100)
    .join("\n");
  assert.match(card, /SUBAGENTS/);
  assert.match(card, /1\/1 completed/);
  assert.match(card, /Found sources/);
  const expandedCard = h
    .render(h.messages[0].message, { expanded: true, outputPad: 0 }, theme)
    .render(100)
    .join("\n");
  assert.match(expandedCard, /300 in \/ 80 out/);
  assert.match(expandedCard, /\d+\.\ds/);
  h.agents.shutdown();
});

test("one child failure is reported with the other result and does not abort the batch", async () => {
  const runner: typeof runSubagent = async (_task, index, m) => {
    if (index === 0) throw new Error("Provider unavailable");
    return {
      index,
      model: `${m.provider}/${m.id}`,
      status: "completed",
      text: "Second task succeeded",
      turns: 1,
      usage: { input: 10, output: 5, cost: 0 },
    };
  };
  const h = setup(runner);
  const call = await h.execute("call_subagents", { tasks: [{ context: "First" }, { context: "Second" }] });
  await flush();
  const batch = (await h.execute("view_subagents", { batchId: call.details.batchId })).json;
  assert.deepEqual(
    batch.tasks.map((task: any) => task.status),
    ["failed", "completed"],
  );
  assert.match(batch.tasks[0].result, /Provider unavailable/);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].settings, { triggerTurn: true, deliverAs: "followUp" });
  h.agents.shutdown();
});

test("cancel_subagents distinguishes cancellation request from actual task exit", async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const runner: typeof runSubagent = async (_task, index, m, _thinking, _registry, _parent, abortSignal) => {
    signal = abortSignal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      index,
      model: `${m.provider}/${m.id}`,
      status: "completed",
      text: "late",
      turns: 1,
      usage: { input: 1, output: 1, cost: 0 },
    };
  };
  const h = setup(runner);
  const call = await h.execute("call_subagents", { tasks: [{ context: "Long tool" }] });
  await flush();
  await h.execute("cancel_subagents", { batchId: call.details.batchId });
  assert.ok(signal.aborted);
  assert.equal(
    (await h.execute("view_subagents", { id: call.details.taskIds[0] })).json.task.status,
    "cancelling",
  );
  finish();
  await flush();
  assert.equal(
    (await h.execute("view_subagents", { id: call.details.taskIds[0] })).json.task.status,
    "cancelled",
  );
  assert.equal(h.messages.length, 0);
  h.agents.shutdown();
});

test("/new and shutdown abort old tasks and prevent late delivery and cross-session queries", async () => {
  let finish!: () => void;
  let signal!: AbortSignal;
  const runner: typeof runSubagent = async (_task, index, m, _thinking, _registry, _parent, abortSignal) => {
    signal = abortSignal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      index,
      model: `${m.provider}/${m.id}`,
      status: "completed",
      text: "late",
      turns: 0,
      usage: { input: 0, output: 0, cost: 0 },
    };
  };
  const h = setup(runner);
  const call = await h.execute("call_subagents", { tasks: [{ context: "Long task" }] });
  await flush();
  h.switchSession();
  assert.ok(signal.aborted);
  finish();
  await flush();
  assert.equal(h.messages.length, 0);
  assert.deepEqual((await h.execute("view_subagents")).json.batches, []);
  await assert.rejects(h.execute("view_subagents", { batchId: call.details.batchId }), /not found/);
  h.agents.shutdown();
});
