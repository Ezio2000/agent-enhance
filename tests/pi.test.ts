import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createPiEnhance } from "../packages/hosts/pi/src/index.ts";
import { PiCredentialResolver } from "../packages/hosts/pi/src/auth.ts";
import { PreferenceStore, emptyPiPreferences } from "../packages/integrations/services/src/preferences.ts";
import { StaticCredentialResolver } from "../packages/core/src/auth.ts";
import { channels } from "../packages/integrations/services/src/sources/channels.ts";
import { piServiceSource } from "../packages/hosts/pi/src/auth.ts";
import type { Catalog } from "../packages/integrations/services/src/catalog.ts";
const preferences = (home: string) => new PreferenceStore(home, "pi", emptyPiPreferences);
async function harness(home: string, initial: string[] = []) {
  let available = initial;
  const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8")) as Catalog;
  const tools = new Map<string, any>();
  let active = ["read", "unrelated"];
  const events = new Map<string, Function[]>(),
    commands = new Map<string, any>();
  const messages: string[] = [];
  const statusCalls: Array<[string, string | undefined]> = [];
  let nextChoice: string | undefined;
  let choices: Array<string | undefined | ((items: string[]) => string | undefined)> = [];
  const dialogs: Array<{ title: string; items: string[] }> = [];
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    registerMessageRenderer() {},

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
      select: async (title: string, items: string[]) => {
        dialogs.push({ title, items });
        const choice = choices.length ? choices.shift() : nextChoice;
        return typeof choice === "function" ? choice(items) : choice;
      },
      setFooter() {},
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
    scopedModels: [],
    modelRegistry: {
      getProviderAuth: async () => undefined,
      getAvailable: () => [
        {
          provider: "openai-codex",
          id: "gpt-6-astra",
          name: "Astra",
          input: ["text", "image"],
          reasoning: true,
        },
        {
          provider: "minimax-cn",
          id: "MiniMax-M2.7",
          name: "MiniMax M2.7",
          input: ["text"],
          reasoning: true,
        },
      ],
    },
    waitForIdle: async () => {},
    isIdle: () => true,
  } as unknown as ExtensionCommandContext;
  createPiEnhance(pi, {
    home,
    catalog,
    moduleDirectory: join(process.cwd(), "dist/modules"),
    sources: () => [
      {
        id: "pi",
        async discover() {
          return available.map((providerId) => {
            const def = channels[providerId]!;
            return {
              id: `pi:${providerId}`,
              provider: def.provider,
              channel: def.channel,
              kind: def.kind,
              source: "pi",
              label: providerId,
              credentials: new StaticCredentialResolver({
                [`${def.provider}/${def.channel}`]: {
                  kind: def.kind,
                  secret: "fixture",
                  baseUrl: def.baseUrl,
                },
              }),
            };
          });
        },
      },
    ],
  });
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
    services: (...providers: string[]) => {
      available = providers;
    },
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
    dialogs,
    choose: (...values: typeof choices) => {
      choices = values;
    },
    chooseOnce: (value: string | undefined) => {
      nextChoice = value;
    },
  };
}
test("host-only subagents stay off by default, enable explicitly and persist without installing provider modules", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-subagents-host-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.ok(!h.active().includes("call_subagents"));
    assert.match(await h.command("subagents enable"), /enabled/);
    assert.ok(h.active().includes("call_subagents"));
    assert.ok(h.active().includes("view_subagent_models"));
    assert.ok(h.active().includes("view_subagents"));
    assert.ok(h.active().includes("cancel_subagents"));
    assert.equal(preferences(home).load().subagents.enabled, true);
    assert.match(await h.command("subagents status"), /enabled/);
    assert.match(await h.command("subagents disable"), /disabled/);
    assert.ok(!h.active().includes("call_subagents"));
    assert.equal(preferences(home).load().subagents.enabled, false);
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("subagent default model picker, explicit selection, scope validation, persistence and inherit", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-subagent-model-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.match(await h.command("subagents model"), /outside TUI/);
    assert.match(await h.command("subagents model unknown/nope"), /not enabled and available/);
    assert.equal(preferences(home).load().subagents.model, undefined);
    assert.match(await h.command("subagents model minimax-cn/MiniMax-M2.7"), /Saved subagent default model/);
    assert.equal(preferences(home).load().subagents.model, "minimax-cn/MiniMax-M2.7");
    assert.match(await h.command("subagents status"), /MiniMax-M2\.7 \(available\)/);
    (h.ctx as any).scopedModels = [{ model: { provider: "openai-codex", id: "gpt-6-astra" } }];
    assert.match(await h.command("subagents status"), /unavailable in this Pi session/);
    assert.match(await h.command("subagents model minimax-cn/MiniMax-M2.7"), /not enabled and available/);
    (h.ctx as any).scopedModels = [];
    (h.ctx as any).mode = "tui";
    h.choose((items) => items.find((value) => value.startsWith("openai-codex/gpt-6-astra")));
    assert.match(await h.command("subagents model"), /openai-codex\/gpt-6-astra/);
    assert.equal(preferences(home).load().subagents.model, "openai-codex/gpt-6-astra");
    const reopened = await harness(home);
    await reopened.emit("session_start");
    assert.match(await reopened.command("subagents status"), /default model: openai-codex\/gpt-6-astra/);
    await reopened.emit("session_shutdown");
    h.chooseOnce(undefined);
    assert.equal(await h.command("subagents model"), "");
    assert.equal(preferences(home).load().subagents.model, "openai-codex/gpt-6-astra");
    assert.match(await h.command("subagents model inherit"), /inherit current Pi model/);
    assert.equal(preferences(home).load().subagents.model, undefined);
    await h.emit("session_shutdown");
    const restored = await harness(home);
    await restored.emit("session_start");
    assert.match(await restored.command("subagents status"), /inherit current Pi model/);
    await restored.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi adds scoped remote-release guidance to the system prompt without replacing other sections", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-prompt-"));
  try {
    const h = await harness(home);
    const event = { systemPromptOptions: { sections: { existing: "keep me" } as Record<string, string> } };
    await h.emit("before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections.existing, "keep me");
    const guidance = event.systemPromptOptions.sections.pi_enhance_release;
    assert.ok(guidance);
    assert.match(guidance, /agent-enhance\/pi-enhance/);
    assert.match(guidance, /docs\/release\.md/);
    assert.match(guidance, /https:\/\/github\.com\/Ezio2000\/agent-enhance/);
    assert.match(guidance, /Never persistently install the local working tree/);
    await h.emit("before_agent_start", event);
    assert.equal(event.systemPromptOptions.sections.pi_enhance_release, guidance);
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("Pi auth isolates channels, delegates refresh, sanitizes errors and respects cancellation", async () => {
  const calls: string[] = [];
  const resolver = new PiCredentialResolver(
    {
      async getProviderAuth(provider: string) {
        calls.push(provider);
        return {
          auth: { apiKey: "header.payload.signature", headers: { "chatgpt-account-id": "acct" } },
        } as any;
      },
    },
    "openai-codex",
  );
  const requirement = { provider: "openai" as const, channel: "codex", acceptedKinds: ["oauth" as const] };
  for (let i = 0; i < 2; i++)
    assert.equal((await resolver.resolve(requirement, { interactive: false })).status, "ready");
  assert.deepEqual(calls, ["openai-codex", "openai-codex"]);
  assert.equal(
    (await resolver.resolve({ ...requirement, channel: "api" }, { interactive: false })).status,
    "unsupported",
  );
  const bad = new PiCredentialResolver(
    {
      async getProviderAuth() {
        throw new Error("SECRET_TOKEN");
      },
    },
    "openai-codex",
  );
  const result = await bad.resolve(requirement, { interactive: false });
  assert.equal(result.status, "login_required");
  assert.ok(!JSON.stringify(result).includes("SECRET_TOKEN"));
  const key = new PiCredentialResolver(
    {
      async getProviderAuth() {
        return { auth: { apiKey: "sk-platform" } } as any;
      },
    },
    "openai-codex",
  );
  assert.equal((await key.resolve(requirement, { interactive: false })).status, "login_required");
  const signal = AbortSignal.abort();
  await assert.rejects(resolver.resolve(requirement, { interactive: false, signal }), /abort/i);
  const waiting = new PiCredentialResolver({ getProviderAuth: () => new Promise(() => {}) }, "openai-codex");
  const controller = new AbortController();
  const pending = waiting.resolve(requirement, { interactive: false, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test("Pi discovers credentials automatically, merges providers and updates after logout without installation", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-discovery-pi-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.equal(h.tools.size, 0);
    h.services("openai-codex", "xai");
    await h.command("refresh");
    assert.ok(h.active().includes("gen_image"));
    assert.equal([...h.tools.values()].filter((t) => t.name === "gen_image").length, 1);
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["openai", "xai"]);
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.service.enum, [
      "pi:openai-codex",
      "pi:xai",
    ]);
    assert.match(await h.command("services"), /pi:openai-codex/);
    assert.deepEqual(await readdir(home), [], "discovery does not persist derived state");
    h.services("xai");
    await h.command("refresh");
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["xai"]);
    h.services();
    await h.command("refresh");
    assert.ok(!h.active().includes("gen_image"));
    assert.ok(h.active().includes("unrelated"));
    assert.match(await h.command("openai gen_image enable"), /services.*status/);
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi respects host tool exclusions and model-derived vision availability", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-availability-pi-"));
  try {
    const h = await harness(home, ["openai-codex", "zai"]);
    await h.emit("session_start");
    assert.ok(!h.active().includes("view_image"));
    h.setActive(["read", "unrelated"]);
    await h.emit("model_select", { model: { provider: "zai", id: "text-only", input: ["text"] } });
    assert.ok(
      !h.active().includes("gen_image"),
      "model changes preserve manually deactivated existing tools",
    );
    assert.ok(h.active().includes("view_image"));
    await h.emit("model_select", { model: { provider: "zai", id: "vision", input: ["text", "image"] } });
    assert.ok(!h.active().includes("view_image"));
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi preferences persist exact service selection and exclusions; cancelling a picker changes nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-preferences-pi-"));
  try {
    const h = await harness(home, ["openai-codex", "xai"]);
    await h.emit("session_start");
    assert.match(await h.command("prefer gen_image pi:xai"), /Preferred/);
    assert.equal(preferences(home).load().preferred.gen_image, "pi:xai");
    assert.match(await h.command("prefer gen_image pi:zai"), /does not provide/);
    assert.match(await h.command("exclude gen_image pi:openai-codex"), /Excluded/);
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["xai"]);
    await h.command("exclude gen_image");
    assert.ok(!h.active().includes("gen_image"));
    await h.command("include gen_image");
    assert.ok(h.active().includes("gen_image"));
    await h.command("include gen_image pi:openai-codex");
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["openai", "xai"]);
    (h.ctx as any).mode = "tui";
    const before = await readFile(preferences(home).path, "utf8");
    h.chooseOnce(undefined);
    await h.command("");
    assert.equal(await readFile(preferences(home).path, "utf8"), before);
    await h.emit("session_shutdown");
    const reopened = await harness(home, ["openai-codex", "xai"]);
    await reopened.emit("session_start");
    assert.equal(preferences(home).load().preferred.gen_image, "pi:xai");
    await reopened.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("request settings need no modules or credentials and apply only to supported requests", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-requests-pi-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.match(await h.command("fast on"), /Saved fast: on/);
    assert.equal(preferences(home).load().requests.fast, "on");
    assert.match(h.statuses().at(-1)?.[1] ?? "", /fast:on\(2\.5x\)/);
    const handler = h.commands.get("pi-enhance").getArgumentCompletions;
    assert.ok(handler("fast ").some((c: any) => c.value === "fast off"));
    await h.command("verbosity high");
    await h.command("image_detail original");
    assert.equal(h.tools.size, 0);
    await h.emit("model_select", { model: { provider: "kimi-coding", id: "k3", api: "custom" } });
    assert.equal(h.statuses().at(-1)?.[1], undefined);
    (h.ctx as any).mode = "tui";
    h.chooseOnce(undefined);
    assert.equal(await h.command("verbosity"), "");
    assert.equal(preferences(home).load().requests.verbosity, "high");
    await h.command("fast off");
    assert.equal(preferences(home).load().requests.fast, undefined);
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("preference write failures keep runtime and saved state intact", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-locked-pi-"));
  try {
    const h = await harness(home, ["openai-codex"]);
    await h.emit("session_start");
    await mkdir(join(home, "preferences"), { recursive: true });
    await writeFile(`${preferences(home).path}.lock`, "busy");
    assert.match(await h.command("exclude gen_image"), /CONFIG_LOCKED/);
    assert.ok(h.active().includes("gen_image"));
    assert.deepEqual(preferences(home).load().excluded, []);
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi service discovery uses local metadata and binds domestic and international channels without resolving credentials", async () => {
  let resolutions = 0;
  const ctx = {
    modelRegistry: {
      getProviderAuthStatus: (id: string) => ({
        configured: ["minimax", "minimax-cn", "zai", "zai-coding-cn"].includes(id),
        source: "stored",
      }),
      getAll: () => [],
      getRegisteredProviderConfig: () => undefined,
      getProviderAuth: async () => {
        resolutions++;
        return undefined;
      },
    },
  } as unknown as ExtensionCommandContext;
  const connections = await piServiceSource(ctx, {
    env: {},
    modelConfig: {},
    storedCredential: (id) =>
      ["minimax", "minimax-cn", "zai", "zai-coding-cn"].includes(id)
        ? { type: "api_key", key: "fixture" }
        : undefined,
  }).discover();
  assert.deepEqual(
    connections.map((c) => c.id),
    ["pi:minimax-cn", "pi:minimax", "pi:zai", "pi:zai-coding-cn"],
  );
  assert.equal(resolutions, 0);
  const resolution = await connections[1]!.credentials.resolve(
    { provider: "minimax", channel: "token-plan", acceptedKinds: ["api_key"] },
    { interactive: false },
  );
  assert.equal(resolution.status, "missing");
  assert.equal(resolutions, 1);
});

test("Pi discovery reads current credential metadata instead of stale registry snapshots", async () => {
  let stored: { type: string; key: string } | undefined;
  const ctx = {
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      getRegisteredProviderConfig: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
  const source = piServiceSource(ctx, {
    env: {},
    modelConfig: {},
    storedCredential: (id) => (id === "minimax-cn" ? stored : undefined),
  });
  assert.deepEqual(await source.discover(), []);
  stored = { type: "api_key", key: "sk-cp-fixture" };
  assert.deepEqual(
    (await source.discover()).map((c) => c.id),
    ["pi:minimax-cn"],
  );
  stored = undefined;
  assert.deepEqual(await source.discover(), []);
});

test("Pi discovers JSONC model keys and registered extension keys without resolving them", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-model-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home;
  let resolves = 0;
  try {
    await writeFile(
      join(home, "models.json"),
      '\uFEFF{ // a valid Pi config\n "providers": {"minimax-cn": {"apiKey": "${KEY}"}}\n}',
    );
    const env: NodeJS.ProcessEnv = {};
    const ctx = {
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: false }),
        getRegisteredProviderConfig: () => undefined,
        getProviderAuth: async () => {
          resolves++;
          return undefined;
        },
        refresh: async () => {
          resolves++;
        },
      },
    } as unknown as ExtensionCommandContext;
    const source = piServiceSource(ctx, { env, storedCredential: () => undefined });
    assert.deepEqual(await source.discover(), []);
    env.KEY = "sk-cp-fixture";
    assert.deepEqual(
      (await source.discover()).map((c) => c.id),
      ["pi:minimax-cn"],
    );
    assert.equal(resolves, 0);
    const extensionCtx = {
      modelRegistry: {
        getProviderAuthStatus: (id: string) => ({ configured: id === "zai", source: "models_json_command" }),
        getRegisteredProviderConfig: (id: string) => (id === "zai" ? { apiKey: "!get-key" } : undefined),
      },
    } as unknown as ExtensionCommandContext;
    assert.deepEqual(
      (
        await piServiceSource(extensionCtx, {
          env: {},
          modelConfig: {},
          storedCredential: () => undefined,
        }).discover()
      ).map((c) => c.id),
      ["pi:zai"],
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test("Pi platform API-key fallback is not discovered as subscription OAuth", async () => {
  const ctx = {
    modelRegistry: {
      getProviderAuthStatus: (id: string) => ({
        configured: ["openai-codex", "xai"].includes(id),
        source: "fallback",
      }),
      getRegisteredProviderConfig: () => ({ apiKey: "sk-platform" }),
    },
  } as unknown as ExtensionCommandContext;
  assert.deepEqual(
    await piServiceSource(ctx, { env: {}, modelConfig: {}, storedCredential: () => undefined }).discover(),
    [],
  );
});

test("invalid persisted request settings are reported without overwriting the file or working tools", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-invalid-request-"));
  try {
    const h = await harness(home, ["openai-codex"]);
    await h.emit("session_start");
    preferences(home).update((p) => ({ ...p, requests: { fast: "invalid" } }));
    const before = await readFile(preferences(home).path, "utf8");
    assert.match(await h.command("status"), /CONFIG_INVALID.*fast/);
    assert.equal(await readFile(preferences(home).path, "utf8"), before);
    assert.ok(h.active().includes("gen_image"));
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
