import test from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { CapabilityRegistry } from "../packages/core/src/registry.ts";
import { StaticCredentialResolver, requireCredential } from "../packages/core/src/auth.ts";
import type { CapabilityModule, ExecutionContext } from "../packages/core/src/contracts.ts";
import openai from "../packages/capabilities/gen_image/openai/src/index.ts";
import xai from "../packages/capabilities/gen_image/xai/src/index.ts";
import minimax from "../packages/capabilities/gen_image/minimax/src/index.ts";
import webOpenai from "../packages/capabilities/search_web/openai/src/index.ts";
import webZai from "../packages/capabilities/search_web/zai/src/index.ts";
import { transformControlledRequest } from "../packages/core/src/controls.ts";
import { annotateError } from "../packages/core/src/errors.ts";
import { fastControl } from "../packages/hosts/pi/src/requests/fast.ts";
import { verbosityControl } from "../packages/hosts/pi/src/requests/verbosity.ts";
import { imageDetailControl } from "../packages/hosts/pi/src/requests/image-detail.ts";
import { supportsModelOption } from "../packages/transports/openai/src/model-support.ts";
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
test("search_web merge floats shared commands and namespaces provider extras", async () => {
  const registry = new CapabilityRegistry();
  registry.load(fake(webOpenai), services);
  registry.load(fake(webZai), services);
  const merged = registry.tools().find((t) => t.name === "search_web")!;
  const top = Object.keys(merged.parameters.properties);
  assert.ok(top.includes("search_query") && top.includes("open") && top.includes("provider"));
  assert.ok(!top.includes("click") && !top.includes("search_engine"));
  const options = merged.parameters.properties.options.properties as Record<
    string,
    { properties: Record<string, unknown> }
  >;
  assert.deepEqual(Object.keys(options), ["openai", "zai"]);
  assert.ok("click" in options.openai!.properties && "finance" in options.openai!.properties);
  assert.ok("search_engine" in options.zai!.properties && "return_format" in options.zai!.properties);
  const seen: unknown[] = [];
  const routed = new CapabilityRegistry();
  routed.load(
    {
      ...fake(webZai),
      create(s) {
        const instance = fake(webZai).create(s);
        instance.tool = {
          ...instance.tool!,
          execute: async (_id, args) => {
            seen.push(args);
            return { content: [{ type: "text", text: "ok" }], details: {} };
          },
        };
        return instance;
      },
    },
    services,
  );
  const zaiTool = routed.tools()[0]!;
  await zaiTool.execute(
    "c1",
    {
      provider: "zai",
      search_query: [{ q: "x" }],
      options: { zai: { search_engine: "search_pro", location: "China" } },
    },
    undefined,
    undefined,
    context,
  );
  assert.deepEqual(seen[0], { search_query: [{ q: "x" }], search_engine: "search_pro", location: "China" });
  await assert.rejects(
    merged.execute(
      "c2",
      {
        provider: "zai",
        search_query: [{ q: "x" }],
        options: { openai: { click: [{ ref_id: "1", id: 1 }] } },
      } as never,
      undefined,
      undefined,
      context,
    ),
    /PROVIDER_OPTIONS/,
  );
  await registry.dispose();
});

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
test("shared image prompts accept every provider's range and enforce the selected provider's limit", async () => {
  for (const modules of [
    [minimax, openai, xai],
    [xai, openai, minimax],
  ]) {
    const registry = new CapabilityRegistry();
    const received: string[] = [];
    for (const module of modules)
      registry.load(
        fake(module, async (args) => {
          received.push(args.prompt);
          return { content: [], details: {} };
        }),
        services,
      );
    const tool = registry.tools()[0]!;
    const prompt = "x".repeat(32000);
    assert.ok(Value.Check(tool.parameters, { provider: "openai", prompt }));
    assert.ok(!Value.Check(tool.parameters, { provider: "openai", prompt: `${prompt}x` }));
    assert.ok(!Value.Check(tool.parameters, { provider: "openai", prompt: "" }));
    assert.ok(!Value.Check(tool.parameters, { provider: "openai" }));
    for (const provider of ["openai", "xai"])
      await tool.execute("long", { provider, prompt }, undefined, undefined, context);
    await tool.execute(
      "short",
      { provider: "minimax", prompt: "x".repeat(1500) },
      undefined,
      undefined,
      context,
    );
    await assert.rejects(
      tool.execute(
        "too-long",
        { provider: "minimax", prompt: "x".repeat(1501) },
        undefined,
        undefined,
        context,
      ),
      /PROVIDER_ARGUMENTS/,
    );
    assert.deepEqual(
      received.map((value) => value.length),
      [32000, 32000, 1500],
    );
    await registry.dispose();
  }
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
  registry.setPreferred({ gen_image: "xai" });
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
test("GPT-6.1 Sol supports Fast without enabling other request options", () => {
  const model = {
    provider: "openai",
    channel: "codex",
    api: "codex-responses",
    id: "gpt-6.1-sol",
    input: ["text", "image"],
  };
  const payload = { model: model.id, input: [{ role: "user", content: "hello" }] };
  assert.equal(supportsModelOption(model.id, "priority"), true);
  assert.equal(supportsModelOption(model.id, "verbosity"), false);
  assert.equal(supportsModelOption(model.id, "originalImages"), false);
  assert.equal(transformControlledRequest(payload, model, [fastControl], { fast: "off" }), payload);
  assert.deepEqual(transformControlledRequest(payload, model, [fastControl], { fast: "on" }), {
    ...payload,
    service_tier: "priority",
  });
});
test("GPT-6 Sol and Luna support Codex request controls; unknown models remain excluded", () => {
  const controls = [fastControl, verbosityControl, imageDetailControl];
  for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
    for (const option of ["verbosity", "originalImages", "priority"] as const)
      assert.equal(supportsModelOption(id, option), true);
    const model = {
      provider: "openai",
      channel: "codex",
      api: "codex-responses",
      id,
      input: ["text", "image"],
    };
    const payload = {
      model: id,
      input: [{ role: "user", content: [{ type: "input_image", detail: "auto" }] }],
    };
    const result = transformControlledRequest(payload, model, controls, {
      fast: "on",
      verbosity: "high",
      image_detail: "original",
    }) as any;
    assert.equal(result.service_tier, "priority");
    assert.equal(result.text.verbosity, "high");
    assert.equal(result.input[0].content[0].detail, "original");
  }
  assert.equal(supportsModelOption("gpt-6-unknown", "priority"), false);
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
test("exact service bindings distinguish accounts and use the chosen resolver without fallback", async () => {
  const registry = new CapabilityRegistry();
  const module = fake(xai, async () => ({ content: [], details: {} }));
  const connected = (id: string, secret: string) => ({
    id,
    label: id,
    credentials: new StaticCredentialResolver({ "xai/imagine": { kind: "oauth" as const, secret } }),
  });
  const original = module.create;
  module.create = (services) => {
    const instance = original(services);
    instance.tool!.execute = async (_id, _args, _signal, _update, ctx) => {
      const credential = await requireCredential(ctx.credentials, {
        provider: "xai",
        channel: "imagine",
        acceptedKinds: ["oauth"],
      });
      return { content: [], details: { secret: credential.secret } };
    };
    return instance;
  };
  registry.load(module, services, connected("account:a", "a"));
  registry.load(module, services, connected("account:b", "b"));
  const tool = registry.tools()[0]!;
  assert.deepEqual(tool.parameters.properties.provider.enum, ["xai"]);
  assert.deepEqual(tool.parameters.properties.service.enum, ["account:a", "account:b"]);
  await assert.rejects(
    tool.execute("ambiguous", { prompt: "x" }, undefined, undefined, context),
    /PROVIDER_SELECTION/,
  );
  const result = await tool.execute(
    "selected",
    { prompt: "x", service: "account:b" },
    undefined,
    undefined,
    context,
  );
  assert.equal(result.details.secret, "b");
  assert.equal(result.details.service, "account:b");
  registry.setPreferred({ gen_image: "account:a" });
  assert.equal(
    (await tool.execute("preferred", { prompt: "x" }, undefined, undefined, context)).details.secret,
    "a",
  );
  registry.setBinding("gen_image/xai@account:b", {
    id: "account:b",
    label: "b",
    credentials: new StaticCredentialResolver({}),
  });
  await assert.rejects(
    tool.execute("missing", { prompt: "x", service: "account:b" }, undefined, undefined, context),
    /AUTH_MISSING/,
  );
  registry.suspend("gen_image/xai@account:a");
  await assert.rejects(
    tool.execute("suspended", { prompt: "x", service: "account:a" }, undefined, undefined, context),
    /STALE_TOOL/,
  );
  await registry.dispose();
});

test("standalone unload blocks new calls while asynchronous disposal is in progress", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((done) => {
    finish = done;
  });
  const registry = new CapabilityRegistry();
  registry.load(
    { ...fake(xai), create: (services) => ({ ...fake(xai).create(services), dispose: () => gate }) },
    services,
  );
  const tool = registry.tools()[0]!;
  const unloading = registry.unload("gen_image/xai");
  assert.equal(registry.tools().length, 0);
  await assert.rejects(tool.execute("late", { prompt: "x" }, undefined, undefined, context), /STALE_TOOL/);
  finish();
  await unloading;
  assert.equal(registry.list().length, 0);
});

test("concurrent calls with the same host call ID remain busy until both settle", async () => {
  const registry = new CapabilityRegistry();
  const finish: Array<() => void> = [];
  registry.load(
    fake(
      xai,
      () =>
        new Promise((resolve) => {
          finish.push(() => resolve({ content: [], details: {} }));
        }),
    ),
    services,
  );
  const tool = registry.tools()[0]!;
  const a = tool.execute("same", { prompt: "x" }, undefined, undefined, context);
  const b = tool.execute("same", { prompt: "x" }, undefined, undefined, context);
  finish[0]!();
  await a;
  await assert.rejects(registry.unload("gen_image/xai"), /MODULE_BUSY/);
  finish[1]!();
  await b;
  await registry.unload("gen_image/xai");
});
