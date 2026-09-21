import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { ConfigStore } from "../packages/core/src/config.ts";
import { StaticCredentialResolver, requireCredential } from "../packages/core/src/auth.ts";
import { ModuleManager, type Catalog } from "../packages/core/src/modules.ts";
import type { CapabilityModule, ExecutionContext } from "../packages/core/src/contracts.ts";
import openai from "../packages/capabilities/gen_image/openai/src/index.ts";
import xai from "../packages/capabilities/gen_image/xai/src/index.ts";
import { transformControlledRequest } from "../packages/core/src/controls.ts";
import { annotateError } from "../packages/core/src/errors.ts";
import { fastControl } from "../packages/capabilities/fast/openai/src/control.ts";
import { verbosityControl } from "../packages/capabilities/verbosity/openai/src/control.ts";
import { imageDetailControl } from "../packages/capabilities/image_detail/openai/src/control.ts";
const context: ExecutionContext = {
  cwd: process.cwd(),
  sessionId: "test",
  host: "test",
  credentials: new StaticCredentialResolver({}),
};
const services = { artifactRoot: "/unused" };
function fake(
  original: CapabilityModule,
  run: (args: any) => Promise<any> = async (args) => ({
    content: [{ type: "text", text: JSON.stringify(args) }],
    details: {},
  }),
): CapabilityModule {
  return {
    ...original,
    create(s) {
      const instance = original.create(s);
      instance.tool = { ...instance.tool!, execute: (_id, args) => run(args) };
      return instance;
    },
  };
}
test("same capability is merged once; only loaded provider options appear", async () => {
  const registry = new CapabilityRegistry();
  assert.equal(registry.tools().length, 0);
  registry.load(fake(openai), services);
  const first = registry.tools()[0]!;
  assert.equal(first.name, "gen_image");
  assert.deepEqual(Object.keys(first.parameters.properties.options.properties), ["openai"]);
  registry.load(fake(xai), services);
  assert.equal(registry.tools().length, 1);
  const both = registry.tools()[0]!;
  assert.deepEqual(both.parameters.properties.provider.enum, ["openai", "xai"]);
  assert.deepEqual(Object.keys(both.parameters.properties.options.properties), ["openai", "xai"]);
  assert.ok(both.parameters.properties.model.enum.includes("grok-imagine-image-2.0"));
  await registry.unload("gen_image/openai");
  assert.deepEqual(registry.tools()[0]!.parameters.properties.provider.enum, ["xai"]);
  assert.equal(registry.tools()[0]!.parameters.properties.images.maxItems, 5);
  await assert.rejects(first.execute("stale", { prompt: "x" }, undefined, undefined, context), /STALE_TOOL/);
  await registry.unload("gen_image/xai");
  assert.equal(registry.tools().length, 0);
});
test("routing is explicit/default/single; cross-provider options and mismatched models are rejected", async () => {
  const registry = new CapabilityRegistry();
  let calls = 0;
  const run = async (args: any) => {
    calls++;
    return { content: [], details: { received: args } };
  };
  registry.load(fake(openai, run), services);
  registry.load(fake(xai, run), services);
  const tool = registry.tools()[0]!;
  await assert.rejects(
    tool.execute("x", { prompt: "x" }, undefined, undefined, context),
    /PROVIDER_SELECTION/,
  );
  await assert.rejects(
    tool.execute(
      "x",
      { provider: "xai", prompt: "x", options: { openai: { size: "auto" } } },
      undefined,
      undefined,
      context,
    ),
    /PROVIDER_OPTIONS/,
  );
  await assert.rejects(
    tool.execute("x", { provider: "xai", prompt: "x", model: "gpt-image-2" }, undefined, undefined, context),
    /PROVIDER_ARGUMENTS/,
  );
  await assert.rejects(
    tool.execute(
      "x",
      { provider: "xai", prompt: "x", options: { xai: { quality: "high" } } },
      undefined,
      undefined,
      context,
    ),
    /INVALID_ARGUMENTS/,
  );
  assert.equal(calls, 0);
  registry.defaults.gen_image = "xai";
  const result = await tool.execute(
    "x",
    { prompt: "x", options: { xai: { resolution: "2k" } } },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(result.details.received, { prompt: "x", resolution: "2k" });
  assert.equal(result.details.provider, "xai");
  assert.equal(result.details.capability, "gen_image");
  assert.equal(calls, 1);
});
test("failures never trigger another provider; main model does not change routing", async () => {
  const registry = new CapabilityRegistry({ gen_image: "openai" });
  let other = 0;
  registry.load(
    fake(openai, async () => {
      throw new Error("quota");
    }),
    services,
  );
  registry.load(
    fake(xai, async () => {
      other++;
      return { content: [], details: {} };
    }),
    services,
  );
  await assert.rejects(
    registry.tools()[0]!.execute("x", { prompt: "x" }, undefined, undefined, {
      ...context,
      model: { provider: "xai", id: "grok" },
    }),
    /quota/,
  );
  assert.equal(other, 0);
});
test("busy module cannot unload; cancellation reaches implementation; no stale handles after unload", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const registry = new CapabilityRegistry();
  registry.load(
    fake(openai, async () => {
      await gate;
      return { content: [], details: {} };
    }),
    services,
  );
  const tool = registry.tools()[0]!;
  const pending = tool.execute("x", { prompt: "x" }, undefined, undefined, context);
  await assert.rejects(registry.unload("gen_image/openai"), /MODULE_BUSY/);
  release();
  await pending;
  await registry.unload("gen_image/openai");
  await assert.rejects(tool.execute("x", { prompt: "x" }, undefined, undefined, context), /STALE_TOOL/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(tool.execute("x", { prompt: "x" }, abort.signal, undefined, context), /abort/i);
});
test("aborted and timed-out requests keep their real reason instead of a read-only message error", () => {
  // DOMException (AbortSignal.throwIfAborted / timeouts) exposes `message` as a getter.
  const aborted = new DOMException("The operation was aborted.", "AbortError");
  const annotated = annotateError(aborted, '\nPrompt: "circle" · elapsed 12.0s') as Error;
  assert.match(annotated.message, /aborted/i);
  assert.match(annotated.message, /elapsed 12\.0s/);
  assert.ok(!/only a getter/.test(annotated.message));
  assert.equal(annotated.name, "AbortError");
  assert.equal((annotated as Error & { cause?: unknown }).cause, aborted);
  // Ordinary errors keep their identity and code so host routing stays intact.
  const coded = Object.assign(new Error("AUTH_MISSING"), { code: "AUTH_MISSING" });
  const same = annotateError(coded, '\nPrompt: "x"') as Error & { code?: string };
  assert.equal(same, coded);
  assert.equal(same.code, "AUTH_MISSING");
  assert.match(same.message, /AUTH_MISSING\nPrompt: "x"/);
  // Non-Error rejections pass through untouched.
  assert.equal(annotateError("boom", " suffix"), "boom");
});
test("request controls remain API/model scoped and preserve payloads when off", () => {
  const model = {
    provider: "openai",
    channel: "codex",
    api: "codex-responses",
    id: "gpt-6-astra",
    input: ["image", "text"],
  };
  const input = {
    model: model.id,
    input: [{ role: "user", content: [{ type: "input_image", detail: "auto" }] }],
  };
  const controls = [fastControl, verbosityControl, imageDetailControl];
  assert.equal(transformControlledRequest(input, model, controls, {}), input);
  assert.equal(
    transformControlledRequest(input, { ...model, provider: "anthropic" }, controls, { fast: "on" }),
    input,
  );
  assert.equal(
    transformControlledRequest(input, { ...model, id: "unknown" }, controls, { fast: "on" }),
    input,
  );
  const output = transformControlledRequest(input, model, controls, {
    fast: "on",
    verbosity: "high",
    image_detail: "original",
  }) as any;
  assert.equal(output.service_tier, "priority");
  assert.equal(output.text.verbosity, "high");
  assert.equal(output.input[0].content[0].detail, "original");
  assert.equal(input.input[0]!.content[0]!.detail, "auto");
});
test("credentials are resolved each time and never cross channels or accepted kinds", async () => {
  const resolver = new StaticCredentialResolver({
    "openai/api": { kind: "api_key", secret: "secret" },
    "xai/imagine": { kind: "api_key", secret: "secret" },
  });
  await assert.rejects(
    requireCredential(resolver, { provider: "openai", channel: "codex", acceptedKinds: ["oauth"] }),
    /AUTH_MISSING/,
  );
  await assert.rejects(
    requireCredential(resolver, { provider: "xai", channel: "imagine", acceptedKinds: ["oauth"] }),
    /AUTH_KIND/,
  );
  let calls = 0;
  const fresh = {
    async resolve() {
      calls++;
      return { status: "ready" as const, credential: { kind: "oauth" as const, secret: String(calls) } };
    },
  };
  for (let i = 1; i <= 2; i++)
    assert.equal(
      (await requireCredential(fresh, { provider: "openai", channel: "codex", acceptedKinds: ["oauth"] }))
        .secret,
      String(i),
    );
});
test("host configs are isolated, atomically merged, and malformed/locked files survive unchanged", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-config-"));
  try {
    const a = new ConfigStore(home, "pi"),
      b = new ConfigStore(home, "test-host");
    a.update((c) => ({ ...c, controls: { fast: "on" } }));
    a.update((c) => ({ ...c, autoload: ["gen_image/openai"] }));
    assert.deepEqual(a.load().controls, { fast: "on" });
    assert.deepEqual(b.load().controls, {});
    const original = await readFile(a.path, "utf8");
    await writeFile(`${a.path}.lock`, "");
    assert.throws(() => a.update((c) => c), /CONFIG_LOCKED/);
    assert.equal(await readFile(a.path, "utf8"), original);
    await rm(`${a.path}.lock`);
    await writeFile(a.path, "broken");
    assert.throws(() => a.update((c) => c), /CONFIG_INVALID/);
    assert.equal(await readFile(a.path, "utf8"), "broken");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("module install is explicit, integrity pinned, isolated from Pi and unload preserves artifacts", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-modules-"));
  try {
    const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8")) as Catalog;
    let network = 0;
    const manager = new ModuleManager(home, catalog, join(process.cwd(), "dist/modules"), async () => {
      network++;
      throw new Error("network");
    });
    await assert.rejects(manager.load("gen_image/openai"), /NOT_INSTALLED/);
    assert.equal(network, 0);
    await manager.install("gen_image/openai");
    const module = await manager.load("gen_image/openai");
    assert.equal(module.manifest.id, "gen_image/openai");
    assert.equal(manager.installed("gen_image/xai"), undefined);
    assert.equal(network, 0);
    const entry = manager.find("gen_image/openai");
    const path = join(home, "packages", `${entry.sha256}-${entry.file}`);
    await writeFile(path, "tampered");
    await assert.rejects(manager.load("gen_image/openai"), /INTEGRITY/);
    manager.uninstall("gen_image/openai");
    assert.equal(manager.installed("gen_image/openai"), undefined);
    assert.equal(await readFile(path, "utf8"), "tampered");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("download uses pinned HTTPS source without credentials and rejects corrupt downloads", async () => {
  const home = await mkdtemp(join(tmpdir(), "enhance-download-"));
  try {
    const catalog = JSON.parse(await readFile("dist/catalog.json", "utf8")) as Catalog;
    catalog.revision = "a".repeat(40);
    const entry = catalog.modules.find((e) => e.id === "fast/openai")!;
    const bytes = await readFile(join("dist/modules", entry.file));
    const manager = new ModuleManager(home, catalog, undefined, async (url, init) => {
      assert.equal(
        String(url),
        `https://raw.githubusercontent.com/Ezio2000/agent-enhance/${catalog.revision}/dist/modules/${entry.file}`,
      );
      assert.equal(init?.redirect, "error");
      assert.equal(init?.headers, undefined);
      return new Response(bytes);
    });
    await manager.install(entry.id);
    assert.equal((await manager.load(entry.id)).manifest.kind, "request-control");
    const corrupt = new ModuleManager(home, catalog, undefined, async () => new Response("corrupt"));
    await assert.rejects(corrupt.install(entry.id), /INTEGRITY/);
    assert.equal((await manager.load(entry.id)).manifest.id, entry.id);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
