import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSources, sourcePaths } from "../packages/integrations/services/src/sources/files.ts";
import { channels } from "../packages/integrations/services/src/sources/channels.ts";
import {
  discoverServices,
  type ServiceConnection,
  type ServiceSource,
} from "../packages/integrations/services/src/contracts.ts";
import {
  PreferenceStore,
  emptyPreferences,
  emptyPiPreferences,
} from "../packages/integrations/services/src/preferences.ts";
import { ModuleCatalog, type Catalog } from "../packages/integrations/services/src/catalog.ts";
import { ServiceRuntime } from "../packages/integrations/services/src/runtime.ts";
import {
  manageServicePreferences,
  serviceOverview,
} from "../packages/integrations/services/src/management.ts";
import { watchServiceSources } from "../packages/integrations/services/src/watch.ts";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { StaticCredentialResolver } from "../packages/core/src/auth.ts";
import image from "../packages/capabilities/gen_image/xai/src/index.ts";
import space from "../packages/capabilities/space/openai/src/index.ts";
import sites from "../packages/capabilities/sites/openai/src/index.ts";
import type { CapabilityModule } from "../packages/core/src/contracts.ts";

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "enhance-service-test-"));
  const home = join(root, "enhance"),
    env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      CODEX_HOME: join(root, "codex"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      XDG_DATA_HOME: join(root, "data"),
      OPENAI_CODEX_COMPUTER_APP: join(root, "absent.app"),
    };
  const options = { home, env, userHome: root, platform: "linux" as const };
  const write = async (path: string, value: unknown) => {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  return {
    root,
    home,
    env,
    options,
    paths: sourcePaths(options),
    write,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("local discovery finds original sources and both regions without network, commands or credential copies", async () => {
  const box = await sandbox(),
    previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("Network must not run during discovery");
  };
  try {
    const sentinel = join(box.root, "command-ran");
    await box.write(box.paths[0]!, { tokens: { access_token: "expired", refresh_token: "refresh" } });
    await box.write(box.paths[1]!, {
      xai: { type: "oauth", access: "expired", refresh: "refresh", expires: 0 },
      "minimax-cn": { type: "api_key", key: `!touch '${sentinel}'; printf fixture` },
      minimax: { type: "api_key", key: "sk-cp-global" },
      "zai-coding-cn": { type: "api_key", key: "${ZAI_FROM_ENV}" },
    });
    await box.write(box.paths[2]!, { "opencode-go": { type: "api", key: "go-key" } });
    box.env.ZAI_API_KEY = "global-key";
    box.env.ZAI_FROM_ENV = "cn-key";
    const before = await readFile(box.paths[1]!, "utf8");
    const result = await discoverServices(fileSources(box.options));
    assert.deepEqual(result.errors, {});
    assert.deepEqual(
      result.connections.map((c) => c.id),
      [
        "codex:openai-codex",
        "opencode:opencode-go",
        "pi:xai",
        "pi:minimax-cn",
        "pi:minimax",
        "pi:zai-coding-cn",
        "env:ZAI_API_KEY",
      ],
    );
    assert.equal(calls, 0);
    assert.equal(await readFile(box.paths[1]!, "utf8"), before);
    assert.ok(!(await readdir(box.root)).includes("command-ran"));
    assert.ok(!(await readdir(box.root)).includes("enhance"));
    const global = result.connections.find((c) => c.id === "pi:minimax")!;
    const credential = await global.credentials.resolve(
      { provider: "minimax", channel: "token-plan", acceptedKinds: ["api_key"] },
      { interactive: false },
    );
    assert.equal(credential.status === "ready" && credential.credential.baseUrl, "https://api.minimax.io");
    const wrong = await global.credentials.resolve(
      { provider: "openai", channel: "codex", acceptedKinds: ["oauth"] },
      { interactive: false },
    );
    assert.equal(wrong.status, "unsupported");
  } finally {
    globalThis.fetch = previousFetch;
    await box.cleanup();
  }
});

test("Pi OAuth refresh writes only to the original source and serializes rotating refresh tokens", async () => {
  const box = await sandbox(),
    previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(
      JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
      { status: 200 },
    );
  };
  try {
    await box.write(box.paths[1]!, {
      xai: { type: "oauth", access: "old", refresh: "refresh", expires: 0, custom: "preserved" },
      zai: { type: "api_key", key: "untouched" },
    });
    const snapshot = await discoverServices(fileSources(box.options));
    assert.equal(requests, 0);
    const service = snapshot.connections.find((c) => c.id === "pi:xai")!;
    const request = { provider: "xai", channel: "imagine", acceptedKinds: ["oauth"] } as const;
    const resolutions = await Promise.all([
      service.credentials.resolve(request, { interactive: false }),
      service.credentials.resolve(request, { interactive: false }),
    ]);
    assert.equal(requests, 1);
    assert.ok(resolutions.every((r) => r.status === "ready" && r.credential.secret === "new-access"));
    const saved = JSON.parse(await readFile(box.paths[1]!, "utf8"));
    assert.equal(saved.xai.refresh, "new-refresh");
    assert.equal(saved.xai.custom, "preserved");
    assert.deepEqual(saved.zai, { type: "api_key", key: "untouched" });
    assert.ok(!(await readdir(box.root)).includes("enhance"));
  } finally {
    globalThis.fetch = previousFetch;
    await box.cleanup();
  }
});

test("malformed sources are reported independently; platform API keys do not become subscription OAuth", async () => {
  const box = await sandbox();
  try {
    await box.write(box.paths[1]!, {
      "openai-codex": { type: "api_key", key: "platform" },
      xai: { type: "api_key", key: "platform" },
    });
    await mkdir(join(box.paths[0]!, ".."), { recursive: true });
    await writeFile(box.paths[0]!, "broken");
    box.env.ZAI_API_KEY = "zai-key";
    const snapshot = await discoverServices(fileSources(box.options));
    assert.deepEqual(
      snapshot.connections.map((c) => c.id),
      ["env:ZAI_API_KEY"],
    );
    assert.ok(snapshot.errors.codex);
    assert.equal(await readFile(box.paths[0]!, "utf8"), "broken");
  } finally {
    await box.cleanup();
  }
});

function runtimeFixture(run = async () => ({ content: [], details: {} }), base = image) {
  const module: CapabilityModule = {
    ...base,
    create: (services) => ({
      ...base.create(services),
      tool: { ...base.create(services).tool!, execute: run },
    }),
  };
  const catalog: Catalog = {
    version: 2,
    release: "test",
    modules: [
      {
        ...module.manifest,
        file: `${module.manifest.capability}--${module.manifest.provider}.mjs`,
        bytes: 1,
        label: module.definition.label,
        group: module.definition.group,
      },
    ],
  };
  const modules = new ModuleCatalog(catalog, "/unused");
  modules.load = async () => module;
  const registry = new CapabilityRegistry();
  const connection: ServiceConnection = {
    id: "account:one",
    source: "fixture",
    label: "one",
    provider: "xai",
    channel: "imagine",
    kind: "oauth",
    credentials: new StaticCredentialResolver({}),
  };
  let connections = [connection],
    failed = false;
  const source: ServiceSource = {
    id: "fixture",
    discover: async () => {
      if (failed) throw new Error("source unavailable");
      return connections;
    },
  };
  const runtime = new ServiceRuntime({ modules, registry, services: () => ({ artifactRoot: "/unused" }) });
  return {
    runtime,
    registry,
    source,
    connection,
    setConnections: (next: ServiceConnection[]) => {
      connections = next;
    },
    fail: () => {
      failed = true;
    },
  };
}

test("management explains the routed connection, lists choices and guides recovery", async () => {
  const f = runtimeFixture();
  const root = await mkdtemp(join(tmpdir(), "enhance-management-test-"));
  const store = new PreferenceStore(root, "claude-code", emptyPreferences);
  const conditions = { features: new Set<string>() };
  const sync = () => f.runtime.synchronize([f.source], store.load(), conditions);
  const manage = (line: string) => manageServicePreferences(line.split(" "), store, f.runtime, "/x");
  f.setConnections(["agent-enhance:xai/imagine", "pi:xai"].map((id) => ({ ...f.connection, id, label: id })));
  try {
    await sync();
    assert.match(manage("status")!, /✓ gen_image\s+pi:xai · default · \+1 alternative/);
    assert.match(manage("services")!, /pi:xai · pi:xai\n\s+provides: gen_image/);
    assert.match(manage("prefer gen_image")!, /currently uses pi:xai \(automatic\)[\s\S]*pi:xai\s+← current/);
    assert.throws(() => manage("prefer imag"), /Unknown capability "imag"\. Did you mean gen_image\?/);
    assert.throws(
      () => manage("prefer gen_image pi:xia"),
      /does not provide gen_image\. Did you mean pi:xai\? Services for gen_image: pi:xai, agent-enhance:xai\/imagine/,
    );
    assert.match(manage("prefer gen_image agent-enhance:xai/imagine")!, /^Preferred/);
    await sync();
    assert.match(manage("status")!, /agent-enhance:xai\/imagine · preferred/);
    assert.match(manage("exclude gen_image agent-enhance:xai/imagine")!, /keeps its other connections/);
    assert.match(manage("exclude gen_image agent-enhance:xai/imagine")!, /already excluded/);
    await sync();
    assert.match(
      manage("status")!,
      /✗ gen_image\s+saved preference agent-enhance:xai\/imagine is unavailable.*\/x prefer gen_image auto/,
    );
    assert.match(manage("exclude gen_image")!, /hidden until \/x include gen_image/);
    assert.match(manage("include gen_image")!, /^Included gen_image\.$/);
    assert.match(
      manage("include gen_image")!,
      /not excluded as a whole; only these connections are: agent-enhance:xai\/imagine\. Restore one with \/x include gen_image <service>/,
    );
    assert.match(manage("include gen_image agent-enhance:xai/imagine")!, /^Included gen_image@agent-enhance/);
    assert.deepEqual(store.load().excluded, []);
    assert.match(manage("include gen_image")!, /not excluded; nothing changed/);
    f.setConnections([]);
    await sync();
    assert.match(manage("status")!, /✗ gen_image\s+no connection · sign in with Pi \/login → xai/);
    assert.match(serviceOverview(f.runtime, store.load(), "/x"), /No service connections discovered/);
  } finally {
    await f.runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

for (const module of [space, sites]) {
  test(`${module.manifest.capability} defaults to native Codex OAuth and respects explicit selection and exclusions`, async () => {
    const f = runtimeFixture(undefined, module);
    const capability = module.manifest.capability;
    const connections = ["pi:openai-codex", "codex:openai-codex"].map((id) => ({
      ...f.connection,
      id,
      provider: "openai" as const,
      channel: "codex",
    }));
    const preferences = emptyPreferences();
    const conditions = { features: new Set<string>() };
    const context = {
      cwd: "/unused",
      sessionId: "test",
      host: "test",
      credentials: new StaticCredentialResolver({}),
    };
    const call = (args = {}) =>
      f.registry.tools()[0]!.execute("test", { action: "list", ...args }, undefined, undefined, context);
    try {
      f.setConnections(connections);
      await f.runtime.synchronize([f.source], preferences, conditions);
      assert.equal((await call()).details.service, "codex:openai-codex");
      assert.equal((await call({ service: "pi:openai-codex" })).details.service, "pi:openai-codex");
      assert.deepEqual(preferences.preferred, {});
      await f.runtime.synchronize(
        [f.source],
        { ...preferences, preferred: { [capability]: "pi:openai-codex" } },
        conditions,
      );
      assert.equal((await call()).details.service, "pi:openai-codex");
      await f.runtime.synchronize(
        [f.source],
        { ...preferences, excluded: [`${capability}@codex:openai-codex`] },
        conditions,
      );
      assert.equal((await call()).details.service, "pi:openai-codex");
      f.setConnections([connections[0]!]);
      await f.runtime.synchronize([f.source], preferences, conditions);
      assert.equal((await call()).details.service, "pi:openai-codex");
      await f.runtime.synchronize(
        [f.source],
        { ...preferences, preferred: { [capability]: "codex:openai-codex" } },
        conditions,
      );
      await assert.rejects(call(), /PROVIDER_SELECTION/);
    } finally {
      await f.runtime.dispose();
    }
  });
}

test("fresh installations route every capability without preferences, including provider overrides, without retrying failures", async () => {
  const box = await sandbox();
  const catalog: Catalog = JSON.parse(
    await readFile(new URL("../dist/catalog.json", import.meta.url), "utf8"),
  );
  const modules = new ModuleCatalog(catalog, "/unused");
  const calls: string[] = [];
  let fail = false;
  modules.load = async (id) => {
    const entry = catalog.modules.find((m) => m.id === id)!;
    return {
      manifest: { ...entry, platforms: undefined },
      definition: { id: entry.capability, label: entry.label, group: entry.group },
      create: () => ({
        tool: {
          name: entry.capability,
          label: entry.label,
          description: "Routing fixture",
          parameters: Type.Object({}),
          execute: async () => {
            calls.push(id);
            if (fail) throw new Error("Provider failed");
            return { content: [], details: {} };
          },
        },
      }),
    };
  };
  const credentials = new StaticCredentialResolver({});
  let connections: ServiceConnection[] = Object.entries(channels).flatMap(([id, channel]) =>
    [
      `pi:${id}`,
      `agent-enhance:${channel.provider}/${channel.channel}`,
      ...(channel.env ? [`env:${channel.env}`] : []),
    ].map((service) => ({ ...channel, id: service, source: "fixture", label: service, credentials })),
  );
  connections = [...new Map(connections.map((c) => [c.id, c])).values()];
  connections.push(
    {
      ...channels["openai-codex"]!,
      id: "codex:openai-codex",
      source: "fixture",
      label: "Codex",
      credentials,
    },
    {
      provider: "openai",
      channel: "chatgpt-desktop",
      kind: "runtime",
      id: "local:chatgpt-desktop",
      source: "fixture",
      label: "Desktop",
      credentials,
    },
  );
  const source = { id: "fixture", discover: async () => connections };
  const registry = new CapabilityRegistry();
  const runtime = new ServiceRuntime({ modules, registry, services: () => ({ artifactRoot: box.root }) });
  const conditions = {
    features: new Set(catalog.modules.flatMap((m) => m.requires ?? [])),
    platform: "darwin" as const,
  };
  const store = new PreferenceStore(box.home, "pi", emptyPiPreferences);
  const call = (capability: string, args = {}) =>
    registry
      .tools()
      .find((t) => t.name === capability)!
      .execute("test", args, undefined, undefined, {
        cwd: box.root,
        sessionId: "test",
        host: "test",
        credentials,
      });
  const expected = {
    gen_image: "pi:xai",
    gen_video: "pi:xai",
    gen_voice: "pi:minimax-cn",
    search_web: "codex:openai-codex",
    space: "codex:openai-codex",
    sites: "codex:openai-codex",
    use_computer: "local:chatgpt-desktop",
    view_image: "pi:zai",
    view_pdf: "pi:opencode-go",
    view_video: "pi:opencode-go",
  };
  try {
    assert.deepEqual(
      [...new Set(catalog.modules.map((m) => m.capability))].sort(),
      Object.keys(expected).sort(),
    );
    for (const host of ["pi", "claude-code"] as const) {
      const prefs =
        host === "pi" ? store.load() : new PreferenceStore(box.home, host, emptyPreferences).load();
      connections.reverse();
      await runtime.synchronize([source], prefs, conditions);
      for (const [capability, service] of Object.entries(expected))
        assert.equal((await call(capability)).details.service, service, `${host}: ${capability}`);
    }
    await assert.rejects(readFile(store.path), { code: "ENOENT" });
    assert.equal((await call("gen_image", { provider: "openai" })).details.service, "codex:openai-codex");
    assert.equal(
      (await call("gen_image", { service: "pi:openai-codex" })).details.service,
      "pi:openai-codex",
    );
    await runtime.synchronize(
      [source],
      { ...store.load(), preferred: { gen_image: "codex:openai-codex" } },
      conditions,
    );
    assert.equal((await call("gen_image")).details.service, "codex:openai-codex");
    assert.equal((await call("gen_image", { provider: "xai" })).details.service, "pi:xai");
    await runtime.synchronize([source], { ...store.load(), preferred: { gen_image: "missing" } }, conditions);
    await assert.rejects(call("gen_image"), /PROVIDER_SELECTION/);
    await runtime.synchronize([source], { ...store.load(), excluded: ["gen_image@pi:xai"] }, conditions);
    assert.equal((await call("gen_image")).details.service, "agent-enhance:xai/imagine");
    connections = connections.filter((c) => c.provider !== "xai");
    await runtime.synchronize([source], store.load(), conditions);
    assert.equal((await call("gen_image")).details.service, "codex:openai-codex");
    fail = true;
    const before = calls.length;
    await assert.rejects(call("gen_image"), /Provider failed/);
    assert.equal(calls.length, before + 1);
  } finally {
    await runtime.dispose();
    await box.cleanup();
  }
});

test("runtime derives tools from services, treats failed discovery as unknown, and removes logged-out connections", async () => {
  const f = runtimeFixture(),
    preferences = emptyPreferences(),
    conditions = { features: new Set<string>() };
  await f.runtime.synchronize([f.source], preferences, conditions);
  assert.equal(f.registry.tools().length, 1);
  f.fail();
  await f.runtime.synchronize([f.source], preferences, conditions);
  assert.equal(f.registry.tools().length, 1);
  assert.match(f.runtime.describe(), /source unavailable/);
  await f.runtime.synchronize([{ id: "fixture", discover: async () => [] }], preferences, conditions);
  assert.equal(f.registry.tools().length, 0);
  assert.equal(f.runtime.states[0]!.status, "missing");
  await f.runtime.dispose();
});

test("busy excluded connections stop accepting new calls and are disposed after the active call settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const f = runtimeFixture(async () => {
    await gate;
    return { content: [], details: {} };
  });
  const preferences = emptyPreferences(),
    conditions = { features: new Set<string>() };
  await f.runtime.synchronize([f.source], preferences, conditions);
  const tool = f.registry.tools()[0]!;
  const context = {
    cwd: "/unused",
    sessionId: "test",
    host: "test",
    credentials: new StaticCredentialResolver({}),
  };
  const call = tool.execute("active", { prompt: "x" }, undefined, undefined, context);
  await f.runtime.synchronize([f.source], { ...preferences, excluded: ["gen_image"] }, conditions);
  assert.equal(f.registry.tools().length, 0);
  await assert.rejects(tool.execute("new", { prompt: "x" }, undefined, undefined, context), /STALE_TOOL/);
  release();
  await call;
  await f.runtime.synchronize([f.source], { ...preferences, excluded: ["gen_image"] }, conditions);
  assert.equal(f.registry.list().length, 0);
  await f.runtime.dispose();
});

test("preferences are host-scoped, atomic and reject malformed or locked data without overwriting", async () => {
  const box = await sandbox();
  try {
    const pi = new PreferenceStore(box.home, "pi", emptyPiPreferences),
      cc = new PreferenceStore(box.home, "claude-code", emptyPreferences);
    assert.equal(pi.load().subagents.enabled, false);
    pi.update((p) => ({ ...p, requests: { fast: "on" } }));
    cc.update((p) => ({ ...p, excluded: ["gen_image"] }));
    assert.deepEqual(pi.load().excluded, []);
    assert.deepEqual(cc.load().excluded, ["gen_image"]);
    const before = await readFile(pi.path, "utf8");
    await writeFile(`${pi.path}.lock`, "busy");
    assert.throws(() => pi.update((p) => ({ ...p, excluded: ["view_pdf"] })), /CONFIG_LOCKED/);
    assert.equal(await readFile(pi.path, "utf8"), before);
    await rm(`${pi.path}.lock`);
    await writeFile(pi.path, "broken");
    assert.throws(() => pi.load(), /CONFIG_INVALID/);
    assert.throws(() => pi.update((p) => p), /CONFIG_INVALID/);
    assert.equal(await readFile(pi.path, "utf8"), "broken");
  } finally {
    await box.cleanup();
  }
});

test("source watchers observe creation beneath missing directories and atomic replacements", async () => {
  const box = await sandbox();
  let done!: () => void;
  let next = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stop = watchServiceSources([box.paths[1]!], () => done());
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("watch timed out")), 3000);
  });
  try {
    await box.write(box.paths[1]!, {});
    await Promise.race([next, timeout]);
    next = new Promise<void>((resolve) => {
      done = resolve;
    });
    await writeFile(box.paths[1]!, JSON.stringify({ zai: { type: "api_key", key: "fixture" } }));
    await Promise.race([next, timeout]);
  } finally {
    clearTimeout(timer);
    stop();
    await box.cleanup();
  }
});

test("environment templates and source overrides resolve without running commands during discovery", async () => {
  const box = await sandbox();
  try {
    await box.write(box.paths[1]!, {
      zai: { type: "api_key", key: "prefix-${KEY}-$$-$!", env: { KEY: "local" } },
      "zai-coding-cn": { type: "api_key", key: "${MISSING}" },
    });
    const snapshot = await discoverServices(fileSources(box.options));
    assert.deepEqual(
      snapshot.connections.map((c) => c.id),
      ["pi:zai"],
    );
    const result = await snapshot.connections[0]!.credentials.resolve(
      { provider: "zai", channel: "coding-plan", acceptedKinds: ["api_key"] },
      { interactive: false },
    );
    assert.equal(result.status === "ready" && result.credential.secret, "prefix-local-$-!");
  } finally {
    await box.cleanup();
  }
});

test("expired Codex tokens without a refresh token do not advertise a usable connection", async () => {
  const box = await sandbox();
  try {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 60 })).toString(
      "base64url",
    );
    await box.write(box.paths[0]!, { tokens: { access_token: `h.${payload}.s` } });
    assert.deepEqual((await discoverServices(fileSources(box.options))).connections, []);
  } finally {
    await box.cleanup();
  }
});
