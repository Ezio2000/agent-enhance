// packages/hosts/pi/src/index.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resizeImage
} from "@earendil-works/pi-coding-agent";

// packages/core/src/registry.ts
import { Type } from "typebox";
import { Value } from "typebox/value";

// packages/core/src/auth.ts
var EnhanceError = class extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "EnhanceError";
  }
};

// packages/core/src/registry.ts
var imageCommon = /* @__PURE__ */ new Set(["prompt", "images", "model", "timeout_seconds"]);
var strings = (values) => Type.Unsafe({ type: "string", enum: [...new Set(values)] });
var object = (x) => !!x && typeof x === "object" && !Array.isArray(x);
var CapabilityRegistry = class {
  entries = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Set();
  defaults;
  constructor(defaults = {}) {
    this.defaults = { ...defaults };
  }
  list() {
    return [...this.entries.values()];
  }
  get(id) {
    return this.entries.get(id);
  }
  load(module, services) {
    const { manifest } = module;
    if (manifest.apiVersion !== 1 || manifest.id !== `${manifest.capability}/${manifest.provider}` || !/^[a-z][a-z0-9_]*$/.test(manifest.capability))
      throw new EnhanceError("MODULE_CONTRACT", "Invalid module identity or API version.");
    if (this.entries.has(manifest.id)) return;
    if (manifest.platforms && !manifest.platforms.includes(process.platform))
      throw new EnhanceError("PLATFORM", `Module requires ${manifest.platforms.join(", ")}.`);
    const instance = module.create(services);
    if (manifest.kind === "tool" && (!instance.tool || instance.tool.name !== manifest.capability))
      throw new EnhanceError("MODULE_CONTRACT", "Tool name must match capability.");
    this.entries.set(manifest.id, { module, instance });
  }
  async unload(id) {
    if (this.pending.has(id))
      throw new EnhanceError("MODULE_BUSY", "Wait for the active call before unloading.");
    const entry = this.entries.get(id);
    await entry?.instance.dispose?.();
    this.entries.delete(id);
  }
  async lifecycle(event, isIdle) {
    const results = await Promise.allSettled(this.list().map((e) => e.instance.lifecycle?.(event, isIdle)));
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        `Lifecycle ${event} failed`
      );
  }
  async dispose() {
    const results = await Promise.allSettled(this.list().map((e) => e.instance.dispose?.()));
    this.entries.clear();
    const errors = results.filter((r) => r.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((r) => r.reason),
        "Module cleanup failed"
      );
  }
  tools() {
    const groups = /* @__PURE__ */ new Map();
    for (const entry of this.list())
      if (entry.instance.tool) {
        const cap = entry.module.manifest.capability;
        groups.set(cap, [...groups.get(cap) ?? [], entry]);
      }
    return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([cap, entries]) => this.merge(cap, entries));
  }
  merge(capability, entries) {
    const providers = entries.map((e) => e.module.manifest.provider);
    const first = entries[0].instance.tool;
    const properties = { provider: Type.Optional(strings(providers)) };
    const options = {};
    for (const { module, instance } of entries) {
      const schema = instance.tool.parameters;
      const specific = {};
      const required = schema.required ?? [];
      for (const [key, field] of Object.entries(schema.properties)) {
        if (capability === "gen_image" && !imageCommon.has(key))
          specific[key] = required.includes(key) ? field : Type.Optional(field);
        else if (!properties[key]) properties[key] = required.includes(key) ? field : Type.Optional(field);
      }
      if (Object.keys(specific).length)
        options[module.manifest.provider] = Type.Optional(
          Type.Object(specific, { additionalProperties: false })
        );
    }
    if (capability === "gen_image") {
      properties.images = Type.Optional(
        Type.Array(
          Type.Object(
            {
              path: Type.Optional(Type.String({ minLength: 1 })),
              image_url: Type.Optional(Type.String({ minLength: 1 }))
            },
            { additionalProperties: false }
          ),
          {
            minItems: 1,
            maxItems: Math.max(...entries.map((e) => e.instance.tool.parameters.properties.images.maxItems))
          }
        )
      );
      properties.model = Type.Optional(
        strings(entries.flatMap((e) => e.instance.tool.parameters.properties.model?.enum ?? []))
      );
    }
    if (Object.keys(options).length)
      properties.options = Type.Optional(Type.Object(options, { additionalProperties: false }));
    const parameters = Type.Object(properties, { additionalProperties: false });
    return {
      name: capability,
      label: capability,
      description: `One ${capability} tool; loaded providers: ${providers.join(", ")}. Select provider explicitly or use the configured default. No cross-provider fallback. Provider-specific image parameters belong in options.<provider>.
` + entries.map((e) => `[${e.module.manifest.provider}] ${e.instance.tool.description}`).join("\n"),
      promptSnippet: first.promptSnippet,
      promptGuidelines: [...new Set(entries.flatMap((e) => e.instance.tool.promptGuidelines ?? []))],
      parameters,
      execute: async (callId, raw, signal, onUpdate, context) => {
        signal?.throwIfAborted();
        if (!Value.Check(parameters, raw))
          throw new EnhanceError(
            "INVALID_ARGUMENTS",
            "Arguments do not match the current loaded capability schema."
          );
        const args = raw;
        const provider = args.provider ?? this.defaults[capability] ?? (providers.length === 1 ? providers[0] : void 0);
        const entry = entries.find((e) => e.module.manifest.provider === provider);
        if (!entry)
          throw new EnhanceError(
            "PROVIDER_SELECTION",
            `Choose a loaded provider for ${capability}: ${providers.join(", ")}.`
          );
        const id = entry.module.manifest.id;
        if (this.entries.get(id) !== entry)
          throw new EnhanceError("STALE_TOOL", "Capability changed; use the refreshed tool schema.");
        const { provider: ignored, options: rawOptions, ...common } = args;
        const selectedOptions = object(rawOptions) ? rawOptions : {};
        if (Object.keys(selectedOptions).some((key) => key !== provider))
          throw new EnhanceError("PROVIDER_OPTIONS", "Only options for the selected provider are accepted.");
        const backendOptions = selectedOptions[String(provider)];
        const native = { ...common, ...object(backendOptions) ? backendOptions : {} };
        if (!Value.Check(entry.instance.tool.parameters, native))
          throw new EnhanceError(
            "PROVIDER_ARGUMENTS",
            `Arguments are unsupported by ${provider}; check model and input limits.`
          );
        const activeContext = { ...context, signal };
        this.pending.add(`${id}:${callId}`);
        this.pending.add(id);
        const normalize = (result) => ({
          ...result,
          details: { ...result.details, version: 1, capability, provider }
        });
        try {
          return normalize(
            await entry.instance.tool.execute(
              callId,
              native,
              signal,
              onUpdate ? (r) => onUpdate(normalize(r)) : void 0,
              activeContext
            )
          );
        } finally {
          this.pending.delete(`${id}:${callId}`);
          if (![...this.pending].some((key) => key.startsWith(`${id}:`))) this.pending.delete(id);
        }
      }
    };
  }
};

// packages/core/src/config.ts
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
function enhanceHome() {
  return process.env.AGENT_ENHANCE_HOME ?? join(homedir(), ".agent-enhance");
}
var emptyConfig = () => ({ version: 1, autoload: [], defaults: {}, controls: {} });
function readJson(path, fallback) {
  if (!existsSync(path)) return fallback();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch {
    throw new EnhanceError("CONFIG_INVALID", `Cannot read ${path}; original file was not changed.`);
  } finally {
    closeSync(fd);
  }
}
function updateJson(path, fallback, update) {
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, "wx", 384);
  } catch {
    throw new EnhanceError("CONFIG_LOCKED", `Retry after the other writer finishes: ${path}`);
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const value = update(readJson(path, fallback));
    const fd = openSync(temp, "wx", 384);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    return value;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
function validate(config) {
  if (config?.version !== 1 || !Array.isArray(config.autoload) || config.autoload.some((x) => typeof x !== "string") || !config.defaults || !config.controls || typeof config.defaults !== "object" || typeof config.controls !== "object" || Array.isArray(config.defaults) || Array.isArray(config.controls) || Object.values(config.defaults).some((x) => typeof x !== "string") || Object.values(config.controls).some((x) => typeof x !== "string"))
    throw new EnhanceError("CONFIG_INVALID", "Unsupported host configuration; not overwritten.");
  return config;
}
var ConfigStore = class {
  path;
  constructor(home, host) {
    if (!/^[a-z][a-z0-9-]*$/.test(host)) throw new Error("Invalid host ID");
    this.path = join(home, "hosts", `${host}.json`);
  }
  load() {
    return validate(readJson(this.path, emptyConfig));
  }
  update(update) {
    return updateJson(this.path, emptyConfig, (c) => validate(update(validate(c))));
  }
};

// packages/core/src/modules.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join as join2 } from "node:path";
import { pathToFileURL } from "node:url";
var emptyLock = () => ({ version: 1, modules: {} });
var ModuleManager = class {
  constructor(home, catalog, bundledDirectory, fetchImpl = fetch) {
    this.home = home;
    this.catalog = catalog;
    this.bundledDirectory = bundledDirectory;
    this.fetchImpl = fetchImpl;
    this.lockPath = join2(home, "modules.lock.json");
    if (catalog.version !== 1 || catalog.repository !== "Ezio2000/agent-enhance")
      throw new EnhanceError("CATALOG_INVALID", "Untrusted module catalog.");
    for (const entry of catalog.modules)
      if (!/^[a-z_]+\/[a-z]+$/.test(entry.id) || !/^[a-z_]+--[a-z]+\.mjs$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.bytes > 25 * 1024 * 1024)
        throw new EnhanceError("CATALOG_INVALID", "Invalid module entry.");
  }
  lockPath;
  find(id) {
    const entry = this.catalog.modules.find((e) => e.id === id);
    if (!entry) throw new EnhanceError("MODULE_UNKNOWN", `Unknown capability/provider: ${id}`);
    return entry;
  }
  installed(id) {
    const lock = readJson(this.lockPath, emptyLock);
    if (lock.version !== 1 || !lock.modules)
      throw new EnhanceError("LOCK_INVALID", "Invalid module lock; not overwritten.");
    return lock.modules[id];
  }
  path(entry) {
    return join2(this.home, "packages", `${entry.sha256}-${entry.file}`);
  }
  verify(bytes, entry) {
    if (bytes.byteLength !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new EnhanceError("MODULE_INTEGRITY", `Integrity verification failed: ${entry.id}`);
  }
  async install(id, signal) {
    const entry = this.find(id);
    signal?.throwIfAborted();
    let bytes;
    if (this.bundledDirectory) {
      try {
        bytes = await readFile(join2(this.bundledDirectory, entry.file), { signal });
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    if (!bytes) {
      if (!/^[a-f0-9]{40}$/.test(this.catalog.revision))
        throw new EnhanceError(
          "MODULE_SOURCE",
          "This development catalog has no immutable download revision. Build locally first."
        );
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(6e4)]) : AbortSignal.timeout(6e4);
      const url = `https://raw.githubusercontent.com/${this.catalog.repository}/${this.catalog.revision}/dist/modules/${entry.file}`;
      const response = await this.fetchImpl(url, { redirect: "error", signal: requestSignal });
      if (!response.ok || !response.body)
        throw new EnhanceError("MODULE_DOWNLOAD", `Module download returned HTTP ${response.status}.`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > entry.bytes)
          throw new EnhanceError("MODULE_INTEGRITY", "Downloaded module exceeds its declared size.");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    }
    this.verify(bytes, entry);
    signal?.throwIfAborted();
    await mkdir(join2(this.home, "packages"), { recursive: true, mode: 448 });
    const target = this.path(entry), temp = `${target}.${randomUUID2()}.tmp`;
    try {
      await writeFile(temp, bytes, { mode: 384, flag: "wx", signal });
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }
    updateJson(this.lockPath, emptyLock, (lock) => ({
      version: 1,
      modules: { ...lock.modules, [id]: { version: entry.version, sha256: entry.sha256, file: entry.file } }
    }));
  }
  async load(id) {
    const entry = this.find(id), installed = this.installed(id);
    if (!installed)
      throw new EnhanceError("MODULE_NOT_INSTALLED", `Install ${id} explicitly before loading.`);
    if (installed.sha256 !== entry.sha256)
      throw new EnhanceError("MODULE_VERSION", `Reinstall ${id} to match this host version.`);
    this.verify(await readFile(this.path(entry)), entry);
    const loaded = (await import(pathToFileURL(this.path(entry)).href)).default;
    if (JSON.stringify(loaded?.manifest) !== JSON.stringify(
      Object.fromEntries(
        Object.entries(entry).filter(([key]) => !["file", "sha256", "bytes"].includes(key))
      )
    ))
      throw new EnhanceError("MODULE_CONTRACT", "Downloaded manifest does not match catalog.");
    return loaded;
  }
  uninstall(id) {
    this.find(id);
    updateJson(this.lockPath, emptyLock, (lock) => {
      const modules = { ...lock.modules };
      delete modules[id];
      return { version: 1, modules };
    });
  }
};

// packages/core/src/controls.ts
function transformControlledRequest(payload, model, controls, state) {
  if (!model || model.provider !== "openai" || model.channel !== "codex" || model.api !== "codex-responses")
    return payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  let result = payload;
  if (!Array.isArray(result.input) || result.model !== model.id) return payload;
  for (const control of controls) {
    const value = state[control.id] ?? "off";
    if (value !== "off" && control.choices.includes(value) && control.supported(model))
      result = control.transform(result, value);
  }
  return result;
}

// packages/hosts/pi/src/auth.ts
var channels = {
  "openai/codex": "openai-codex",
  "xai/imagine": "xai",
  "opencode/go": "opencode-go"
};
var PiCredentialResolver = class {
  constructor(registry) {
    this.registry = registry;
  }
  async resolve(request, context) {
    context.signal?.throwIfAborted();
    const provider = channels[`${request.provider}/${request.channel}`];
    if (!provider)
      return {
        status: "unsupported",
        guidance: `Pi authentication does not support ${request.provider}/${request.channel}.`
      };
    const guidance = `Authenticate using Pi /login and select ${provider}.`;
    try {
      const signal = AbortSignal.any([
        ...context.signal ? [context.signal] : [],
        AbortSignal.timeout(15e3)
      ]);
      const resolved = await new Promise(
        (resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          this.registry.getProviderAuth(provider).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        }
      );
      context.signal?.throwIfAborted();
      const auth = resolved?.auth;
      const headers = new Headers();
      for (const [key, value] of Object.entries(auth?.headers ?? {}))
        if (typeof value === "string") headers.set(key, value);
      const secret = auth?.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!secret) return { status: "missing", guidance };
      const kind = provider === "opencode-go" ? "api_key" : "oauth";
      if (kind === "oauth" && secret.split(".").length !== 3)
        return {
          status: "login_required",
          guidance: `${guidance} This capability requires subscription OAuth, not a platform API key.`
        };
      if (!request.acceptedKinds.includes(kind))
        return {
          status: "unsupported",
          guidance: "This channel does not accept the credential type resolved by Pi."
        };
      return {
        status: "ready",
        credential: {
          kind,
          secret,
          accountId: headers.get("chatgpt-account-id") ?? void 0,
          baseUrl: auth?.baseUrl
        }
      };
    } catch {
      context.signal?.throwIfAborted();
      return { status: "login_required", guidance };
    }
  }
};

// packages/hosts/pi/src/history.ts
var object2 = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function piHistory(entries) {
  const messages = [];
  for (const entry of entries)
    if (object2(entry)) {
      if (entry.type === "message") messages.push(entry.message);
      else if (entry.type === "compaction" && Array.isArray(entry.retainedTail))
        messages.push(...entry.retainedTail);
    }
  return messages.flatMap((message) => {
    if (!object2(message) || message.role !== "user" && message.role !== "assistant") return [];
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.filter(object2).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
    return text ? [{ role: message.role, content: text }] : [];
  });
}

// packages/hosts/pi/src/index.ts
var command = "pi-enhance";
var support = /* @__PURE__ */ new Set(["approval", "task-settled", "request-interception"]);
function modelInfo(model) {
  if (!model) return;
  return {
    id: model.id,
    provider: model.provider === "openai-codex" ? "openai" : model.provider,
    channel: model.provider === "openai-codex" ? "codex" : void 0,
    api: model.api === "openai-codex-responses" ? "codex-responses" : model.api,
    input: model.input
  };
}
function executionContext(ctx) {
  return {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    host: "pi",
    model: modelInfo(ctx.model),
    credentials: new PiCredentialResolver(ctx.modelRegistry),
    signal: ctx.signal,
    history: piHistory(ctx.sessionManager.buildContextEntries()),
    choose: ctx.hasUI ? (title, choices, signal) => ctx.ui.select(title, choices, { signal }) : void 0
  };
}
function createPiEnhance(pi, options) {
  const store = new ConfigStore(options.home, "pi");
  let config = store.load();
  const registry = new CapabilityRegistry(config.defaults);
  const manager = new ModuleManager(options.home, options.catalog, options.moduleDirectory);
  let previousProvider;
  let disposed = false;
  let registered = /* @__PURE__ */ new Set();
  const knownNames = /* @__PURE__ */ new Set();
  const report = (ctx, text, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
    else {
      pi.sendMessage({ customType: "pi-enhance", content: text, display: true }, { triggerTurn: false });
      if (ctx.mode === "print") console.log(text);
    }
  };
  const statusLine = (ctx) => {
    const model = modelInfo(ctx.model);
    const labels = registry.list().filter((e) => {
      const control = e.instance.control;
      return control && model?.provider === "openai" && model.channel === "codex" && model.api === "codex-responses" && control.supported(model);
    }).map((e) => {
      const control = e.instance.control, value = config.controls[control.id] ?? "off";
      return [control.id, control.formatValue ? control.formatValue(value, model) : value];
    });
    if (ctx.hasUI)
      ctx.ui.setStatus(
        command,
        labels.length ? labels.map(([id, value]) => `${id}:${value}`).join(" ") : void 0
      );
  };
  const refresh = (ctx) => {
    const tools = registry.tools();
    const active = new Set(pi.getActiveTools());
    for (const tool of tools) {
      const collision = pi.getAllTools().find((t) => t.name === tool.name);
      if (collision && !knownNames.has(tool.name))
        throw new Error(`Tool collision: ${tool.name}; disable the conflicting extension first.`);
      pi.registerTool({
        ...tool,
        execute: (id, args, signal, update, piContext) => tool.execute(id, args, signal, update, executionContext(piContext))
      });
      if (!registered.has(tool.name)) active.add(tool.name);
    }
    const available = new Set(tools.map((t) => t.name));
    for (const name of registered) if (!available.has(name)) active.delete(name);
    registered = available;
    for (const name of available) knownNames.add(name);
    pi.setActiveTools([...active]);
    statusLine(ctx);
  };
  const synchronize = refresh;
  const load = async (id, ctx) => {
    const manifest = manager.find(id);
    const unsupported = manifest.requires?.filter((r) => !support.has(r));
    if (unsupported?.length) throw new Error(`Host lacks: ${unsupported.join(", ")}`);
    const module = await manager.load(id);
    registry.load(module, {
      artifactRoot: join3(options.home, "artifacts", "pi", manifest.capability, manifest.provider),
      preview: (bytes, mime) => resizeImage(bytes, mime, { maxWidth: 1024, maxHeight: 1024, maxBytes: 512 * 1024 })
    });
    try {
      synchronize(ctx);
    } catch (error) {
      await registry.unload(id);
      throw error;
    }
  };
  const saveConfig = (update) => {
    config = store.update(update);
    for (const key of Object.keys(registry.defaults)) delete registry.defaults[key];
    Object.assign(registry.defaults, config.defaults);
  };
  const status = async (ctx) => {
    const credentials = new PiCredentialResolver(ctx.modelRegistry);
    const lines = [];
    for (const entry of options.catalog.modules) {
      const loaded = registry.get(entry.id);
      let ready = "\u2014";
      if (loaded) {
        if (entry.auth)
          ready = (await credentials.resolve(entry.auth, { signal: ctx.signal, interactive: false })).status;
        else if (entry.capability === "use_computer") ready = "runtime checked on first use";
        else ready = "ready";
      }
      lines.push(
        `${entry.id}: ${manager.installed(entry.id) ? "installed" : "not installed"}, ${loaded ? "loaded" : "unloaded"}, ${ready}`
      );
    }
    return [
      ...lines,
      `Defaults: ${JSON.stringify(config.defaults)}`,
      `Controls: ${JSON.stringify(config.controls)}`,
      `Home: ${options.home}`
    ].join("\n");
  };
  const usage = "/pi-enhance <provider> <capability> install|load [--save]|unload [--save]|uninstall|status; /pi-enhance openai fast on; /pi-enhance defaults gen_image openai; /pi-enhance status|catalog";
  const run = async (args, ctx) => {
    if (disposed) return;
    await ctx.waitForIdle();
    const words = args.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (ctx.mode !== "tui") {
        report(ctx, usage);
        return;
      }
      const choices = [
        "status",
        "catalog",
        ...options.catalog.modules.map((e) => `${e.provider} ${e.capability}`)
      ];
      const chosen = await ctx.ui.select("Pi Enhance", choices);
      if (chosen) await run(chosen, ctx);
      return;
    }
    if (words[0] === "status" && words.length === 1) {
      report(ctx, await status(ctx));
      return;
    }
    if (words[0] === "catalog" && words.length === 1) {
      report(ctx, options.catalog.modules.map((e) => `${e.id} (${e.kind}, ${e.version})`).join("\n"));
      return;
    }
    if (words[0] === "defaults" && words.length === 3) {
      const [, capability2, provider2] = words;
      const entry2 = manager.find(`${capability2}/${provider2}`);
      if (entry2.kind !== "tool") throw new Error("Only tools have default providers.");
      saveConfig((c) => ({ ...c, defaults: { ...c.defaults, [capability2]: provider2 } }));
      report(ctx, `Saved default ${capability2}: ${provider2}. No backend calls were made.`);
      return;
    }
    if (words.length < 2 || words.length > 4 || words.length === 4 && words[3] !== "--save")
      throw new Error(usage);
    const [provider, capability, action] = words;
    const id = `${capability}/${provider}`, entry = manager.find(id);
    const persist = words[3] === "--save";
    if (persist && action !== "load" && action !== "unload")
      throw new Error("--save is valid only with load/unload.");
    if (!action) {
      if (ctx.mode !== "tui") throw new Error("Explicit action/value required outside TUI.");
      if (!registry.get(id)) {
        const action2 = await ctx.ui.select(
          id,
          manager.installed(id) ? ["load", "load --save", "uninstall"] : ["install"]
        );
        if (action2) await run(`${provider} ${capability} ${action2}`, ctx);
        return;
      }
      const control = registry.get(id)?.instance.control;
      if (control) {
        const choice = await ctx.ui.select(`${id}: ${config.controls[control.id] ?? "off"}`, [
          ...control.choices
        ]);
        if (choice) await run(`${provider} ${capability} ${choice}`, ctx);
      } else {
        const choice = await ctx.ui.select(
          id,
          capability === "use_computer" ? ["status", "ask", "auto", "reset", "revoke", "unload"] : ["status", "unload"]
        );
        if (choice) await run(`${provider} ${capability} ${choice}`, ctx);
      }
      return;
    }
    if (action === "install") {
      await manager.install(id);
      report(ctx, `Installed ${id}; not loaded. Run /pi-enhance ${provider} ${capability} load --save.`);
      return;
    }
    if (action === "load") {
      const wasLoaded = !!registry.get(id);
      await load(id, ctx);
      try {
        if (persist) saveConfig((c) => ({ ...c, autoload: [.../* @__PURE__ */ new Set([...c.autoload, id])] }));
      } catch (error) {
        if (!wasLoaded) {
          await registry.unload(id);
          synchronize(ctx);
        }
        throw error;
      }
      report(ctx, `Loaded ${id}${persist ? "; saved for future Pi sessions" : "; session only"}.`);
      return;
    }
    if (action === "unload" || action === "uninstall") {
      if (persist || action === "uninstall")
        saveConfig((c) => ({ ...c, autoload: c.autoload.filter((value) => value !== id) }));
      await registry.unload(id);
      synchronize(ctx);
      if (action === "uninstall") manager.uninstall(id);
      report(ctx, `${action}: ${id}. Historical artifacts retained.`);
      return;
    }
    if (action === "status") {
      report(
        ctx,
        registry.get(id)?.instance.status ? JSON.stringify(registry.get(id).instance.status(), null, 2) : (await status(ctx)).split("\n").find((line) => line.startsWith(id)) ?? id
      );
      return;
    }
    const instance = registry.get(id)?.instance;
    if (!instance) throw new Error(`Load ${id} first. No implicit downloads or loading.`);
    if (instance.control) {
      const control = instance.control, value = control.aliases?.[action] ?? action;
      if (!control.choices.includes(value)) throw new Error(`Choose ${control.choices.join(" / ")}`);
      saveConfig((c) => ({ ...c, controls: { ...c.controls, [control.id]: value } }));
      statusLine(ctx);
      report(
        ctx,
        `Saved ${control.id}: ${value}. ${value === "off" ? "No request override." : control.enabledNotice ?? "Only applied to supported API/models."}`
      );
      return;
    }
    if (instance.manage) {
      report(ctx, await instance.manage(action));
      return;
    }
    throw new Error(usage);
  };
  pi.registerCommand(command, {
    description: "Capability installation, loading and provider settings",
    getArgumentCompletions(prefix) {
      const candidates = [
        "status",
        "catalog",
        ...options.catalog.modules.flatMap(
          (e) => [
            "",
            "install",
            "load",
            "load --save",
            "unload",
            "unload --save",
            "uninstall",
            "status",
            ...e.kind === "request-control" ? e.capability === "verbosity" ? ["off", "low", "medium", "high"] : ["off", "on"] : e.capability === "use_computer" ? ["ask", "auto", "reset", "revoke"] : []
          ].map((a) => `${e.provider} ${e.capability}${a ? ` ${a}` : ""}`)
        ),
        ...options.catalog.modules.filter((e) => e.kind === "tool").map((e) => `defaults ${e.capability} ${e.provider}`)
      ];
      const items = candidates.filter((c) => c.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        await run(args, ctx);
      } catch (error) {
        report(ctx, error instanceof Error ? error.message : "Enhancement operation failed", true);
      }
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    previousProvider = ctx.model?.provider;
    config = store.load();
    Object.assign(registry.defaults, config.defaults);
    for (const id of config.autoload) {
      try {
        await load(id, ctx);
      } catch (error) {
        report(ctx, `${id}: ${error.message}`, true);
      }
    }
    statusLine(ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    const currentModel = event.model ?? ctx.model;
    const current = currentModel?.provider;
    if (previousProvider !== void 0 && current !== previousProvider)
      await registry.lifecycle("provider_change");
    previousProvider = current;
    statusLine({ ...ctx, model: currentModel });
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (disposed) return;
    const controls = registry.list().flatMap((e) => e.instance.control ? [e.instance.control] : []);
    const payload = transformControlledRequest(
      event.payload,
      modelInfo(ctx.model),
      controls,
      config.controls
    );
    if (payload !== event.payload) return payload;
  });
  pi.on("before_agent_start", () => {
    const notices = registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    if (notices.length)
      return { message: { customType: "pi-enhance:recovery", content: notices.join("\n"), display: false } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await registry.lifecycle("task_settled", () => ctx.isIdle());
  });
  pi.on("session_tree", async () => {
    await registry.lifecycle("session_tree");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    try {
      await registry.dispose();
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(command, void 0);
    }
  });
}
function piEnhance(pi) {
  const here = dirname2(fileURLToPath(import.meta.url));
  const dist = existsSync2(join3(here, "catalog.json")) ? here : join3(here, "../../../../dist");
  const catalog = JSON.parse(readFileSync2(join3(dist, "catalog.json"), "utf8"));
  createPiEnhance(pi, { home: enhanceHome(), catalog, moduleDirectory: join3(dist, "modules") });
}
export {
  createPiEnhance,
  piEnhance as default,
  executionContext,
  modelInfo
};
