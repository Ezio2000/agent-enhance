import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { Subagents } from "../packages/hosts/pi/src/subagents/index.ts";
import type { runSubagent } from "../packages/hosts/pi/src/subagents/runner.ts";

const model = { provider: "test", id: "text", name: "Test Text", input: ["text"], reasoning: false };
const imageModel = {
  provider: "test",
  id: "image",
  name: "Test Image",
  input: ["text", "image"],
  reasoning: true,
  thinkingLevelMap: { high: null, low: "low" },
};
function harness(options: { ui?: boolean; active?: string[]; runner?: typeof runSubagent } = {}) {
  const messages: any[] = [];
  const tools = new Map<string, any>();
  let renderer: any;
  let active = options.active ?? [
    "read",
    "search_web",
    "write",
    "call_subagents",
    "view_subagent_models",
    "view_subagents",
    "cancel_subagents",
  ];
  const pi = {
    registerMessageRenderer(_name: string, fn: any) {
      renderer = fn;
    },
    getActiveTools: () => active,
    sendMessage: (message: any, settings: any) => messages.push({ message, settings }),
  } as unknown as ExtensionAPI;
  const subagents = new Subagents(pi, new CapabilityRegistry(), options.runner);
  subagents.setEnabled(true);
  subagents.startSession("one");
  for (const tool of subagents.tools()) tools.set(tool.name, tool);
  const ctx = {
    model,
    thinkingLevel: "off",
    scopedModels: [{ model }],
    modelRegistry: { getAvailable: () => [model, imageModel] },
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => "one",
      getLeafId: () => "anchor",
      getBranch: () => [{ id: "anchor" }],
    },
    hasUI: options.ui ?? false,
    ui: { confirm: async () => false },
  } as unknown as ExtensionContext;
  return {
    subagents,
    tools,
    ctx,
    messages,
    render: (message: any, expanded = false) =>
      renderer(
        message,
        { expanded, outputPad: 0 },
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        },
      )
        .render(100)
        .join("\n"),
    setActive: (names: string[]) => {
      active = names;
    },
  };
}

test("model discovery respects current Pi scope and reports input and thinking metadata", async () => {
  const h = harness();
  const list = h.tools.get("view_subagent_models");
  const result = await list.execute("1", {}, undefined, undefined, h.ctx);
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.total, 1);
  assert.equal(data.models[0].model, "test/text");
  assert.deepEqual(data.models[0].input, ["text"]);
  assert.deepEqual(data.models[0].thinking_levels, ["off"]);
  const filtered = await list.execute("2", { input: "image" }, undefined, undefined, h.ctx);
  assert.equal(JSON.parse(filtered.content[0].text).total, 0);
  (h.ctx as any).scopedModels = [];
  const image = await list.execute("3", { input: "image" }, undefined, undefined, h.ctx);
  assert.deepEqual(JSON.parse(image.content[0].text).models[0].thinking_levels, [
    "off",
    "minimal",
    "low",
    "medium",
  ]);
  h.subagents.shutdown();
});

test("subagents reject unscoped models, unavailable tools, and write requests without approval", async () => {
  const h = harness();
  const call = h.tools.get("call_subagents");
  const task = (extra: Record<string, unknown>) => ({ tasks: [{ context: "1=1?", ...extra }] });
  await assert.rejects(
    call.execute("1", task({ model: "test/image" }), undefined, undefined, h.ctx),
    /not enabled and available/,
  );
  await assert.rejects(
    call.execute("2", task({ tools: ["gen_image"] }), undefined, undefined, h.ctx),
    /not active/,
  );
  await assert.rejects(
    call.execute("3", task({ tools: ["write"] }), undefined, undefined, h.ctx),
    /blocked without interactive/,
  );
  await assert.rejects(
    call.execute("4", task({ tools: ["call_subagents"] }), undefined, undefined, h.ctx),
    /not active/,
  );
  h.subagents.shutdown();
});

test("saved default is used unless task.model overrides it; stale defaults fail instead of falling back", async () => {
  const h = harness();
  const call = h.tools.get("call_subagents");
  h.subagents.setDefaultModel("test/image");
  const list = await h.tools.get("view_subagent_models").execute("m", {}, undefined, undefined, h.ctx);
  assert.equal(JSON.parse(list.content[0].text).default_model, "test/image");
  await assert.rejects(
    call.execute("1", { tasks: [{ context: "1=1?" }] }, undefined, undefined, h.ctx),
    /test\/image is not enabled/,
  );
  const explicit = await call.execute(
    "2",
    { tasks: [{ context: "1=1?", model: "test/text" }] },
    undefined,
    undefined,
    h.ctx,
  );
  assert.ok(h.subagents.cancel(explicit.details.batchId));
  h.subagents.shutdown();
});

test("omitting tools grants none and returns immediately; cancellation suppresses late completion", async () => {
  const h = harness();
  const call = h.tools.get("call_subagents");
  const result = await call.execute("1", { tasks: [{ context: "1=1?" }] }, undefined, undefined, h.ctx);
  const batchId = result.details.batchId;
  assert.match(result.content[0].text, /Started 1 subagent/);
  const view = h.tools.get("view_subagents");
  const one = JSON.parse(
    (await view.execute("v", { id: result.details.taskIds[0] }, undefined, undefined, h.ctx)).content[0].text,
  );
  assert.ok(["queued", "running"].includes(one.task.status));
  assert.equal(one.batchId, batchId);
  const batch = JSON.parse(
    (await view.execute("v", { batchId }, undefined, undefined, h.ctx)).content[0].text,
  );
  assert.equal(batch.tasks[0].id, result.details.taskIds[0]);
  const cancel = h.tools.get("cancel_subagents");
  await cancel.execute("c", { batchId }, undefined, undefined, h.ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const after = JSON.parse(
    (await view.execute("v", { id: result.details.taskIds[0] }, undefined, undefined, h.ctx)).content[0].text,
  );
  assert.ok(["cancelling", "cancelled"].includes(after.task.status));
  assert.equal(h.messages.length, 0);
  h.subagents.shutdown();
});
