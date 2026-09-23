import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { Subagents } from "../packages/hosts/pi/src/subagents/index.ts";

const model = { provider: "test", id: "text", name: "Test Text", input: ["text"], reasoning: false };
const imageModel = {
  provider: "test",
  id: "image",
  name: "Test Image",
  input: ["text", "image"],
  reasoning: true,
  thinkingLevelMap: { high: null, low: "low" },
};
function harness(options: { ui?: boolean; active?: string[] } = {}) {
  const messages: any[] = [];
  const tools = new Map<string, any>();
  let active = options.active ?? ["read", "search_web", "write", "call_subagents", "list_subagent_models"];
  const pi = {
    registerMessageRenderer() {},
    getActiveTools: () => active,
    sendMessage: (message: any, settings: any) => messages.push({ message, settings }),
  } as unknown as ExtensionAPI;
  const subagents = new Subagents(pi, new CapabilityRegistry());
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
    setActive: (names: string[]) => {
      active = names;
    },
  };
}

test("model discovery respects current Pi scope and reports input and thinking metadata", async () => {
  const h = harness();
  const list = h.tools.get("list_subagent_models");
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

test("omitting tools grants none and returns immediately; cancellation suppresses late completion", async () => {
  const h = harness();
  const call = h.tools.get("call_subagents");
  const result = await call.execute("1", { tasks: [{ context: "1=1?" }] }, undefined, undefined, h.ctx);
  const batchId = result.details.batchId;
  assert.match(result.content[0].text, /Started 1 subagent/);
  assert.ok(h.subagents.cancel(batchId));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.messages.length, 0);
  h.subagents.shutdown();
});
