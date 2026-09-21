import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPiEnhance } from "../packages/hosts/pi/src/index.ts";
import { PiCredentialResolver } from "../packages/hosts/pi/src/auth.ts";
import { ConfigStore } from "../packages/core/src/config.ts";
import type { Catalog } from "../packages/core/src/modules.ts";
async function harness(home: string) {
  const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8")) as Catalog;
  const tools = new Map<string, any>();
  let active = ["read", "unrelated"];
  const events = new Map<string, Function[]>(),
    commands = new Map<string, any>();
  const messages: string[] = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    getAllTools() {
      return [...tools.values()];
    },
    getActiveTools() {
      return active;
    },
    setActiveTools(names: string[]) {
      active = names;
    },
    on(name: string, fn: Function) {
      events.set(name, [...(events.get(name) ?? []), fn]);
    },
    sendMessage(message: any) {
      messages.push(message.content);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    mode: "print",
    hasUI: true,
    ui: {
      setStatus(id: string, value?: string) {
        statusCalls.push([id, value]);
      },
      select: async () => undefined,
      notify(message: string) {
        messages.push(message);
      },
    },
    model: {
      provider: "openai-codex",
      id: "gpt-6-astra",
      api: "openai-codex-responses",
      input: ["text", "image"],
    },
    sessionManager: { getSessionId: () => "test", buildContextEntries: () => [] },
    modelRegistry: { getProviderAuth: async () => undefined },
    waitForIdle: async () => {},
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;
  createPiEnhance(pi, { home, catalog, moduleDirectory: join(process.cwd(), "dist/modules") });
  const emit = async (name: string, event = {}) => {
    for (const fn of events.get(name) ?? []) await fn(event, ctx);
  };
  const command = async (text: string) => {
    messages.length = 0;
    await commands.get("pi-enhance").handler(text, ctx);
    return messages.join("\n");
  };
  return {
    tools,
    commands,
    command,
    emit,
    ctx,
    active: () => active,
    setActive: (names: string[]) => {
      active = names;
    },
    messages,
    statuses: () => statusCalls,
  };
}
test("Pi commands install/load two providers but expose only one image tool; unload/reload updates schema", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-pi-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.equal(h.tools.size, 0);
    assert.equal(h.commands.size, 1);
    assert.match(await h.command("openai gen_image load"), /NOT_INSTALLED/);
    await h.command("openai gen_image install");
    assert.equal(h.tools.size, 0);
    assert.match(await h.command("openai gen_image load --save"), /Loaded/);
    assert.ok(h.active().includes("gen_image"));
    await h.command("xai gen_image install");
    await h.command("xai gen_image load");
    assert.equal(h.tools.size, 1);
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["openai", "xai"]);
    assert.deepEqual(new ConfigStore(home, "pi").load().autoload, ["gen_image/openai"]);
    await h.command("openai gen_image unload --save");
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["xai"]);
    await h.command("xai gen_image unload");
    assert.ok(!h.active().includes("gen_image"));
    await h.command("xai gen_image load");
    assert.ok(h.active().includes("gen_image"));
    assert.ok(h.active().includes("unrelated"));
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("Pi model changes do not reactivate disabled tools; saved autoload survives a new host", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-pi-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    await h.command("openai gen_image install");
    await h.command("openai gen_image load --save");
    h.setActive(["read"]);
    await h.emit("model_select", { model: { provider: "xai", id: "test" } });
    assert.deepEqual(h.active(), ["read"]);
    await h.emit("session_shutdown");
    const resumed = await harness(home);
    await resumed.emit("session_start");
    assert.ok(resumed.active().includes("gen_image"));
    assert.deepEqual(resumed.tools.get("gen_image").parameters.properties.provider.enum, ["openai"]);
    await resumed.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("Pi preferences accept explicit values headlessly and do not silently load/download", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-pi-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.match(await h.command("openai fast on"), /Load fast\/openai first/);
    await h.command("openai fast install");
    await h.command("openai fast load --save");
    assert.match(await h.command("openai fast on"), /Saved fast: on/);
    assert.equal(new ConfigStore(home, "pi").load().controls.fast, "on");
    assert.equal(h.statuses().at(-1)?.[1], "fast:on(2.5x)");
    await h.emit("model_select", { model: { provider: "kimi-coding", id: "k3", api: "custom" } });
    assert.equal(h.statuses().at(-1)?.[1], undefined);
    await h.emit("model_select", {
      model: {
        provider: "openai-codex",
        id: "gpt-6-astra",
        api: "openai-codex-responses",
        input: ["text"],
      },
    });
    assert.equal(h.statuses().at(-1)?.[1], "fast:on(2.5x)");
    await h.command("openai fast off");
    assert.equal(h.statuses().at(-1)?.[1], undefined);
    assert.match(await h.command("openai fast"), /Explicit action/);
    assert.match(await h.command("openai fast nonsense"), /Choose/);
    assert.match(await h.command("defaults gen_image openai"), /Saved default/);
    assert.ok(
      h.commands
        .get("pi-enhance")
        .getArgumentCompletions("openai fast ")
        .some((i: any) => i.value === "openai fast on"),
    );
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("Pi auth isolates channels, delegates refresh, sanitizes errors and respects cancellation", async () => {
  const calls: string[] = [];
  const resolver = new PiCredentialResolver({
    async getProviderAuth(provider: string) {
      calls.push(provider);
      return {
        auth: { apiKey: "header.payload.signature", headers: { "chatgpt-account-id": "acct" } },
      } as any;
    },
  });
  const requirement = { provider: "openai" as const, channel: "codex", acceptedKinds: ["oauth" as const] };
  for (let i = 0; i < 2; i++)
    assert.equal((await resolver.resolve(requirement, { interactive: false })).status, "ready");
  assert.deepEqual(calls, ["openai-codex", "openai-codex"]);
  assert.equal(
    (await resolver.resolve({ ...requirement, channel: "api" }, { interactive: false })).status,
    "unsupported",
  );
  const bad = new PiCredentialResolver({
    async getProviderAuth() {
      throw new Error("SECRET_TOKEN");
    },
  });
  const result = await bad.resolve(requirement, { interactive: false });
  assert.equal(result.status, "login_required");
  assert.ok(!JSON.stringify(result).includes("SECRET_TOKEN"));
  const key = new PiCredentialResolver({
    async getProviderAuth() {
      return { auth: { apiKey: "sk-platform" } } as any;
    },
  });
  assert.equal((await key.resolve(requirement, { interactive: false })).status, "login_required");
  const signal = AbortSignal.abort();
  await assert.rejects(resolver.resolve(requirement, { interactive: false, signal }), /abort/i);
  const waiting = new PiCredentialResolver({ getProviderAuth: () => new Promise(() => {}) });
  const controller = new AbortController();
  const pending = waiting.resolve(requirement, { interactive: false, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /abort/i);
});
