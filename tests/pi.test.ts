import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
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
    dialogs,
    choose: (...values: typeof choices) => {
      choices = values;
    },
    chooseOnce: (value: string | undefined) => {
      nextChoice = value;
    },
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
    assert.equal(h.statuses().at(-1)?.[1], "fast:off");
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
test("Pi control panel applies one selection and returns instead of reopening", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-pi-"));
  try {
    const h = await harness(home);
    (h.ctx as any).mode = "tui";
    await h.emit("session_start");
    await h.command("openai fast install");
    await h.command("openai fast load");
    h.chooseOnce("on");
    await h.command("openai fast");
    h.chooseOnce(undefined);
    assert.equal(new ConfigStore(home, "pi").load().controls.fast, "on");
    assert.equal(h.statuses().at(-1)?.[1], "fast:on(2.5x)");
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

test("one-step enable is selective and idempotent; disable/uninstall preserve user artifacts and preferences", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-enable-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.match(await h.command("openai gen_image enable"), /Enabled gen_image\/openai/);
    assert.deepEqual(
      (await readdir(join(home, "packages"))).map((f) => f.split("-").slice(1).join("-")),
      ["gen_image--openai.mjs"],
    );
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["openai"]);
    await h.command("openai gen_image enable");
    assert.deepEqual(new ConfigStore(home, "pi").load().autoload, ["gen_image/openai"]);
    await h.command("openai fast enable");
    assert.equal(
      new ConfigStore(home, "pi").load().controls.fast,
      undefined,
      "enable must not turn on priority billing",
    );
    await h.command("openai fast on");
    await h.command("openai fast disable");
    assert.equal(new ConfigStore(home, "pi").load().controls.fast, "on");
    await h.command("openai fast enable");
    assert.equal(new ConfigStore(home, "pi").load().controls.fast, "on");
    await h.command("openai gen_image disable");
    assert.ok(!h.active().includes("gen_image"));
    assert.ok(!new ConfigStore(home, "pi").load().autoload.includes("gen_image/openai"));
    assert.match(
      await h.command("openai gen_image status"),
      /installed, unloaded, autoload:off, auth:missing/,
    );
    const artifacts = join(home, "artifacts/pi/gen_image/openai");
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "keep.txt"), "keep");
    await h.command("openai gen_image uninstall");
    assert.match(await h.command("openai gen_image status"), /not installed/);
    assert.equal(await readFile(join(artifacts, "keep.txt"), "utf8"), "keep");
    assert.equal((await readdir(join(home, "packages"))).length, 2, "cache retained");
    await h.emit("session_shutdown");
    const next = await harness(home);
    await next.emit("session_start");
    assert.ok(!next.active().includes("gen_image"));
    assert.equal(next.statuses().at(-1)?.[1], "fast:on(2.5x)");
    await next.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed enable/save and uninstall recover state without changing other modules", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-recovery-"));
  try {
    const h = await harness(home),
      store = new ConfigStore(home, "pi");
    await h.emit("session_start");
    store.update((c) => c);
    await writeFile(`${store.path}.lock`, "");
    assert.match(await h.command("openai gen_image enable"), /CONFIG_LOCKED/);
    assert.ok(!h.active().includes("gen_image"));
    assert.deepEqual(store.load().autoload, []);
    await rm(`${store.path}.lock`);
    await h.command("openai gen_image enable");
    await h.command("xai gen_image enable");
    await writeFile(`${store.path}.lock`, "");
    assert.match(await h.command("openai gen_image disable"), /CONFIG_LOCKED/);
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["openai", "xai"]);
    assert.deepEqual(store.load().autoload, ["gen_image/openai", "gen_image/xai"]);
    await rm(`${store.path}.lock`);
    await writeFile(join(home, "modules.lock.json.lock"), "");
    assert.match(await h.command("openai gen_image uninstall"), /CONFIG_LOCKED/);
    assert.deepEqual(
      new Set(h.tools.get("gen_image").parameters.properties.provider.enum),
      new Set(["openai", "xai"]),
    );
    assert.ok(h.active().includes("gen_image"));
    assert.deepEqual(new Set(store.load().autoload), new Set(["gen_image/openai", "gen_image/xai"]));
    await rm(join(home, "modules.lock.json.lock"));
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("feature-first panel shows requirements, performs one action and cancels without installation", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-panel-"));
  try {
    const h = await harness(home);
    (h.ctx as any).mode = "tui";
    await h.emit("session_start");
    h.choose(
      (items) => items.find((x) => x.includes("Images")),
      (items) => items.find((x) => x.includes("/ xai")),
      undefined,
    );
    await h.command("");
    assert.equal(h.tools.size, 0);
    await assert.rejects(readFile(join(home, "modules.lock.json")), /ENOENT/);
    assert.match(h.dialogs.at(-1)!.title, /KiB/);
    assert.match(h.dialogs.at(-1)!.title, /Auth: xai\/imagine/);
    assert.match(h.dialogs.at(-1)!.title, /Platform:/);
    h.choose(
      (items) => items.find((x) => x.includes("Images")),
      (items) => items.find((x) => x.includes("/ xai")),
      "enable",
    );
    assert.match(await h.command(""), /Enabled gen_image\/xai/);
    assert.equal(h.dialogs.length, 6, "one selection closes the panel");
    assert.deepEqual(h.tools.get("gen_image").parameters.properties.provider.enum, ["xai"]);
    h.choose("set default");
    await h.command("xai gen_image manage");
    assert.equal(new ConfigStore(home, "pi").load().defaults.gen_image, "xai");
    h.choose("disable");
    await h.command("xai gen_image manage");
    assert.ok(!h.active().includes("gen_image"));
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("update commands compare local catalog, preserve preferences and never add uninstalled modules", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-update-command-"));
  try {
    const h = await harness(home);
    await h.emit("session_start");
    assert.match(await h.command("openai fast update"), /NOT_INSTALLED/);
    assert.match(await h.command("update --installed"), /No downloads/);
    await h.command("openai fast enable");
    await h.command("openai fast on");
    await h.command("openai fast unload");
    const path = join(home, "modules.lock.json");
    const lock = JSON.parse(await readFile(path, "utf8"));
    lock.modules["fast/openai"].sha256 = "f".repeat(64);
    await writeFile(path, JSON.stringify(lock));
    assert.match(await h.command("updates"), /fast\/openai: ffffffffffff/);
    assert.match(
      await h.command("openai fast enable"),
      /MODULE_VERSION/,
      "enable must not silently update existing installs",
    );
    assert.match(await h.command("update --installed"), /Updated fast\/openai/);
    assert.equal(h.statuses().at(-1)?.[1], undefined, "update must not load");
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8")).modules), ["fast/openai"]);
    assert.equal(new ConfigStore(home, "pi").load().controls.fast, "on");
    assert.deepEqual(new ConfigStore(home, "pi").load().autoload, ["fast/openai"]);
    assert.match(await h.command("updates"), /No updates/);
    assert.match(await h.command("openai fast load"), /Loaded/);
    assert.equal(h.statuses().at(-1)?.[1], "fast:on(2.5x)");
    assert.match(await h.command("openai fast enable --save"), /--save is valid only/);
    await h.emit("session_shutdown");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
