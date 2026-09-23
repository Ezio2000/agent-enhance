// packages/hosts/pi/src/index.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2, join as join4 } from "node:path";
import { fileURLToPath } from "node:url";
import { resizeImage } from "@earendil-works/pi-coding-agent";

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
var COMMON_FIELDS = {
  gen_image: ["prompt", "images", "model", "timeout_seconds"],
  search_web: ["search_query", "open"]
};
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
  assertIdle(id) {
    if (this.pending.has(id))
      throw new EnhanceError("MODULE_BUSY", "Wait for the active call before unloading.");
  }
  async unload(id) {
    this.assertIdle(id);
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
    const groups2 = /* @__PURE__ */ new Map();
    for (const entry of this.list())
      if (entry.instance.tool) {
        const cap = entry.module.manifest.capability;
        groups2.set(cap, [...groups2.get(cap) ?? [], entry]);
      }
    return [...groups2].sort(([a], [b]) => a.localeCompare(b)).map(([cap, entries]) => this.merge(cap, entries));
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
        const common = COMMON_FIELDS[capability];
        if (common && !common.includes(key))
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
            // A provider without reference-image support (e.g. minimax) contributes a floor of 1.
            maxItems: Math.max(
              ...entries.map(
                (e) => e.instance.tool.parameters.properties.images?.maxItems ?? 1
              )
            )
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
      description: `One ${capability} tool; loaded providers: ${providers.join(", ")}. Select provider explicitly or use the configured default. No cross-provider fallback.${COMMON_FIELDS[capability] ? ` Shared fields stay at the top level; provider-specific parameters belong in options.<provider>.` : ""}
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
  if (config?.version !== 1 || !Array.isArray(config.autoload) || config.autoload.some((x) => typeof x !== "string") || !config.defaults || !config.controls || typeof config.defaults !== "object" || typeof config.controls !== "object" || Array.isArray(config.defaults) || Array.isArray(config.controls) || Object.values(config.defaults).some((x) => typeof x !== "string") || Object.values(config.controls).some((x) => typeof x !== "string") || config.subagents !== void 0 && typeof config.subagents !== "boolean" || config.subagentModel !== void 0 && (typeof config.subagentModel !== "string" || !/^[^\s/]+\/\S+$/.test(config.subagentModel)))
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
var moduleId = /^[a-z_]+\/[a-z]+$/;
var hash = /^[a-f0-9]{64}$/;
function validateLock(lock) {
  if (lock?.version !== 1 || !lock.modules || typeof lock.modules !== "object" || Array.isArray(lock.modules) || Object.entries(lock.modules).some(
    ([id, entry]) => !moduleId.test(id) || !entry || typeof entry.version !== "string" || !hash.test(entry.sha256) || entry.file !== `${id.replace("/", "--")}.mjs`
  ))
    throw new EnhanceError("LOCK_INVALID", "Invalid module lock; not overwritten.");
  return lock;
}
var sameInstallation = (a, b) => a?.sha256 === b?.sha256 && a?.version === b?.version && a?.file === b?.file;
var ModuleManager = class {
  constructor(home, catalog, bundledDirectory, fetchImpl = fetch) {
    this.home = home;
    this.catalog = catalog;
    this.bundledDirectory = bundledDirectory;
    this.fetchImpl = fetchImpl;
    this.lockPath = join2(home, "modules.lock.json");
    if (catalog.version !== 1 || catalog.repository !== "Ezio2000/agent-enhance" || !Array.isArray(catalog.modules))
      throw new EnhanceError("CATALOG_INVALID", "Untrusted module catalog.");
    const ids = /* @__PURE__ */ new Set();
    for (const entry of catalog.modules) {
      if (!moduleId.test(entry.id) || entry.id !== `${entry.capability}/${entry.provider}` || entry.apiVersion !== 1 || typeof entry.version !== "string" || entry.file !== `${entry.id.replace("/", "--")}.mjs` || !hash.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 25 * 1024 * 1024 || ids.has(entry.id))
        throw new EnhanceError("CATALOG_INVALID", "Invalid module entry.");
      ids.add(entry.id);
    }
  }
  lockPath;
  find(id) {
    const entry = this.catalog.modules.find((e) => e.id === id);
    if (!entry) throw new EnhanceError("MODULE_UNKNOWN", `Unknown capability/provider: ${id}`);
    return entry;
  }
  readLock() {
    return validateLock(readJson(this.lockPath, emptyLock));
  }
  installed(id) {
    return this.readLock().modules[id];
  }
  /** Local catalog comparison only: no network, imports, or authentication. */
  updates() {
    const lock = this.readLock();
    return this.catalog.modules.filter((e) => lock.modules[e.id] && lock.modules[e.id].sha256 !== e.sha256);
  }
  path(entry) {
    return join2(this.home, "packages", `${entry.sha256}-${entry.file}`);
  }
  verify(bytes, entry) {
    if (bytes.byteLength !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256)
      throw new EnhanceError("MODULE_INTEGRITY", `Integrity verification failed: ${entry.id}`);
  }
  /** Stage verified bytes without changing installation records or executing the module. */
  async stage(entry, signal) {
    signal?.throwIfAborted();
    try {
      this.verify(await readFile(this.path(entry), { signal }), entry);
      return;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof EnhanceError && error.code === "MODULE_INTEGRITY"))
        throw error;
    }
    let bytes;
    if (this.bundledDirectory) {
      try {
        bytes = await readFile(join2(this.bundledDirectory, entry.file), { signal });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
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
        requestSignal.throwIfAborted();
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
  }
  async commit(entries, before, signal) {
    if (!entries.length) return;
    for (const entry of entries) await this.stage(entry, signal);
    signal?.throwIfAborted();
    updateJson(this.lockPath, emptyLock, (raw) => {
      const current = validateLock(raw);
      for (const entry of entries)
        if (!sameInstallation(current.modules[entry.id], before.modules[entry.id]))
          throw new EnhanceError(
            "MODULE_CONFLICT",
            `Installation changed during download: ${entry.id}. Retry explicitly.`
          );
      const modules = { ...current.modules };
      for (const entry of entries)
        modules[entry.id] = { version: entry.version, sha256: entry.sha256, file: entry.file };
      return { version: 1, modules };
    });
  }
  async install(id, signal) {
    await this.commit([this.find(id)], this.readLock(), signal);
  }
  /** Updates installed modules only; loaded instances remain untouched until a later load. */
  async update(ids, signal) {
    const before = this.readLock();
    const entries = [
      ...new Set(ids ?? this.catalog.modules.filter((e) => before.modules[e.id]).map((e) => e.id))
    ].map((id) => {
      const entry = this.find(id);
      if (!before.modules[id])
        throw new EnhanceError("MODULE_NOT_INSTALLED", `Install ${id} explicitly before updating.`);
      return entry;
    }).filter((entry) => before.modules[entry.id].sha256 !== entry.sha256);
    await this.commit(entries, before, signal);
    return entries.map((e) => e.id);
  }
  async load(id) {
    const entry = this.find(id), installed = this.installed(id);
    if (!installed)
      throw new EnhanceError("MODULE_NOT_INSTALLED", `Install ${id} explicitly before loading.`);
    if (installed.sha256 !== entry.sha256)
      throw new EnhanceError("MODULE_VERSION", `Update or reinstall ${id} to match this host catalog.`);
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
    updateJson(this.lockPath, emptyLock, (raw) => {
      const modules = { ...validateLock(raw).modules };
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
  "opencode/go": "opencode-go",
  "minimax/token-plan": "minimax-cn",
  "zai/coding-plan": "zai",
  "zai/coding-plan-cn": "zai-coding-cn"
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
        (resolve2, reject) => {
          const abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          this.registry.getProviderAuth(provider).then(resolve2, reject).finally(() => signal.removeEventListener("abort", abort));
        }
      );
      context.signal?.throwIfAborted();
      const auth = resolved?.auth;
      const headers = new Headers();
      for (const [key, value] of Object.entries(auth?.headers ?? {}))
        if (typeof value === "string") headers.set(key, value);
      const secret = auth?.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!secret) return { status: "missing", guidance };
      const kind = ["opencode-go", "minimax-cn", "minimax", "zai", "zai-coding-cn"].includes(provider) ? "api_key" : "oauth";
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

// packages/hosts/pi/src/footer.ts
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
var sanitize = (text) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
var formatTokens = (count) => {
  if (count < 1e3) return count.toString();
  if (count < 1e4) return `${(count / 1e3).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1e3)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
};
var formatCwd = (cwd, home) => {
  if (!home) return cwd;
  const relativePath = relative(resolve(home), resolve(cwd));
  const inside = relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  if (!inside) return cwd;
  return relativePath === "" ? "~" : `~${sep}${relativePath}`;
};
function installEnhanceFooter(ctx, statusKey, getLabels) {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {
      },
      render(width) {
        let pwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME ?? process.env.USERPROFILE);
        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;
        const labels = getLabels().filter((label) => label.value.length > 0);
        const labelsPlain = labels.map((label) => `${label.id}:${label.value}`).join(" ");
        const minGap = 2;
        const pwdWidth = visibleWidth(pwd);
        let labelsText;
        if (labelsPlain && pwdWidth + minGap + visibleWidth(labelsPlain) <= width) {
          labelsText = labelsPlain;
        } else if (labelsPlain) {
          const available = width - pwdWidth - minGap;
          if (available >= 8) labelsText = truncateToWidth(labelsPlain, available, "\u2026");
        }
        let firstLine = theme.fg("dim", truncateToWidth(pwd, width, theme.fg("dim", "...")));
        if (labelsText) {
          const styled = labels.map((label) => theme.fg(label.active ? "accent" : "dim", `${label.id}:${label.value}`)).join(" ");
          if (labelsText === labelsPlain) {
            const padding = " ".repeat(width - pwdWidth - visibleWidth(labelsPlain));
            firstLine = theme.fg("dim", pwd) + padding + styled;
          } else {
            firstLine = theme.fg("dim", pwd) + " ".repeat(minGap) + theme.fg("dim", labelsText);
          }
        }
        let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
        let latestCacheHitRate;
        const add = (usage2) => {
          input += usage2.input;
          output += usage2.output;
          cacheRead += usage2.cacheRead;
          cacheWrite += usage2.cacheWrite;
          cost += usage2.cost?.total ?? 0;
        };
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "usage" && entry.usage) add(entry.usage);
          else if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
            add(entry.message.usage);
            const promptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
            latestCacheHitRate = promptTokens > 0 ? entry.message.usage.cacheRead / promptTokens * 100 : void 0;
          } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.usage)
            add(entry.message.usage);
          else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage)
            add(entry.usage);
        }
        const statsParts = [];
        if (input) statsParts.push(`\u2191${formatTokens(input)}`);
        if (output) statsParts.push(`\u2193${formatTokens(output)}`);
        if (cacheRead) statsParts.push(`R${formatTokens(cacheRead)}`);
        if (cacheWrite) statsParts.push(`W${formatTokens(cacheWrite)}`);
        if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== void 0)
          statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
        const usingSubscription = ctx.model?.provider === "kimi-coding";
        if (cost || usingSubscription)
          statsParts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = contextUsage?.percent ?? 0;
        const contextDisplay = contextUsage?.percent == null ? `?/${formatTokens(contextWindow)}` : `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
        statsParts.push(
          percent > 90 ? theme.fg("error", contextDisplay) : percent > 70 ? theme.fg("warning", contextDisplay) : contextDisplay
        );
        if (process.env.PI_EXPERIMENTAL === "1")
          statsParts.push(`${theme.fg("dim", "\u2022")} ${theme.fg("warning", "xp")}`);
        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }
        const modelName = ctx.model?.id || "no-model";
        let rightSide = modelName;
        if (ctx.model?.reasoning) {
          const thinkingLevel = ctx.thinkingLevel || "off";
          rightSide = thinkingLevel === "off" ? `${modelName} \u2022 thinking off` : `${modelName} \u2022 ${thinkingLevel}`;
        }
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`;
          if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
        }
        const rightWidth = visibleWidth(rightSide);
        const lines = [];
        if (statsLeftWidth + 2 + rightWidth <= width) {
          const padding = " ".repeat(width - statsLeftWidth - rightWidth);
          lines.push(theme.fg("dim", statsLeft + padding + rightSide));
        } else {
          const availableForRight = width - statsLeftWidth - 2;
          if (availableForRight > 0) {
            const truncated = truncateToWidth(rightSide, availableForRight, "");
            lines.push(
              theme.fg(
                "dim",
                statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncated))) + truncated
              )
            );
          } else lines.push(theme.fg("dim", statsLeft));
        }
        const otherStatuses = [...footerData.getExtensionStatuses()].filter(([key]) => key !== statusKey).sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => sanitize(text));
        if (otherStatuses.length)
          lines.push(truncateToWidth(otherStatuses.join(" "), width, theme.fg("dim", "...")));
        return [firstLine, ...lines];
      }
    };
  });
}

// packages/hosts/pi/src/management.ts
var groups = [
  { label: "\u56FE\u7247\u751F\u6210 / Images", capabilities: ["gen_image"] },
  { label: "\u89C6\u9891\u751F\u6210 / Video", capabilities: ["gen_video"] },
  { label: "\u8BED\u97F3\u5408\u6210 / Voice", capabilities: ["gen_voice"] },
  { label: "\u8054\u7F51\u641C\u7D22 / Search", capabilities: ["search_web"] },
  { label: "\u6587\u4EF6\u7406\u89E3 / File understanding", capabilities: ["view_pdf", "view_video", "view_image"] },
  { label: "\u684C\u9762\u64CD\u4F5C / Computer use", capabilities: ["use_computer"] },
  { label: "\u5B50\u4EE3\u7406 / Subagents", capabilities: [] },
  { label: "\u8BF7\u6C42\u589E\u5F3A / Request enhancements", capabilities: ["fast", "verbosity", "image_detail"] }
];
var usage = "/pi-enhance <provider> <capability> enable|disable|install|load [--save]|unload [--save]|uninstall|update|status|manage; /pi-enhance subagents enable|disable|status|model [<provider/id>|inherit]|cancel <batch-id>; /pi-enhance defaults <capability> <provider>; /pi-enhance status|catalog|updates|update --installed";
var errorText = (error) => error instanceof Error ? error.message : String(error);
var entryCapability = (id) => id.split("/")[0];
function registerManagement(pi, options) {
  const { manager, registry, config, save, load, refresh, report } = options;
  const setAutoload = (id, enabled) => save((c) => ({
    ...c,
    autoload: enabled ? [.../* @__PURE__ */ new Set([...c.autoload, id])] : c.autoload.filter((value) => value !== id)
  }));
  const state = (entry) => {
    const installed = manager.installed(entry.id);
    return [
      installed ? "installed" : "not installed",
      registry.get(entry.id) ? "loaded" : "unloaded",
      config().autoload.includes(entry.id) ? "autoload:on" : "autoload:off",
      installed && installed.sha256 !== entry.sha256 ? "update available" : void 0
    ].filter(Boolean).join(", ");
  };
  const requirements = (entry) => [
    `${entry.id} \xB7 ${entry.version} \xB7 ${(entry.bytes / 1024).toFixed(1)} KiB`,
    `Platform: ${entry.platforms?.join(", ") ?? "all supported Node.js platforms"}`,
    entry.auth ? `Auth: ${entry.auth.provider}/${entry.auth.channel} (${entry.auth.acceptedKinds.join("/")}); configure via /login` : entry.capability === "use_computer" ? "Requires compatible ChatGPT desktop runtime, local login and macOS permissions; checked on first use" : "Auth: follows the supported main-model request",
    `State: ${state(entry)}`
  ].join("\n");
  const status = async (ctx, only) => {
    const credentials = new PiCredentialResolver(ctx.modelRegistry);
    const lines = [];
    for (const entry of only ? [only] : manager.catalog.modules) {
      let auth = "not checked";
      if (entry.auth)
        auth = (await credentials.resolve(entry.auth, { signal: ctx.signal, interactive: false })).status;
      else auth = entry.capability === "use_computer" ? "runtime checked on first use" : "main-model auth";
      const availability = entry.kind === "tool" ? `, tool:${registry.get(entry.id) && pi.getActiveTools().includes(entry.capability) ? "active" : "inactive (unloaded, model rule or host exclusion)"}` : "";
      lines.push(`${entry.id}: ${state(entry)}, auth:${auth}${availability}`);
      if (only && registry.get(entry.id)?.instance.status)
        lines.push(JSON.stringify(registry.get(entry.id).instance.status(), null, 2));
    }
    if (!only)
      lines.push(
        `Defaults: ${JSON.stringify(config().defaults)}`,
        `Controls: ${JSON.stringify(config().controls)}`,
        `Home: ${manager.home}`,
        options.subagents.status(ctx)
      );
    return lines.join("\n");
  };
  const update = async (ctx, ids) => {
    const updated = await manager.update(ids, options.signal());
    report(
      ctx,
      updated.length ? `Updated ${updated.join(", ")}. Loaded instances are unchanged; new code is used on the next load/reload. Autoload and control preferences retained.` : "Installed modules match this host catalog. No downloads. Update the pi-enhance package first to obtain a newer catalog."
    );
  };
  const remove = async (id, ctx, persist, uninstall) => {
    registry.assertIdle(id);
    options.subagents.assertModuleIdle(entryCapability(id));
    const wasAutoload = config().autoload.includes(id);
    const previous = registry.get(id);
    const active = pi.getActiveTools();
    let saved = false;
    try {
      if (persist) {
        setAutoload(id, false);
        saved = true;
      }
      await registry.unload(id);
      refresh(ctx);
      if (uninstall) manager.uninstall(id);
    } catch (error) {
      const failures = [errorText(error)];
      try {
        if (saved) setAutoload(id, wasAutoload);
      } catch (rollback) {
        failures.push(`Autoload recovery failed: ${errorText(rollback)}`);
      }
      try {
        if (previous && !registry.get(id)) {
          await options.restore(previous.module, ctx);
          pi.setActiveTools(active);
        }
      } catch (rollback) {
        failures.push(`Runtime recovery failed; reload explicitly: ${errorText(rollback)}`);
      }
      throw new Error(failures.join("\n"));
    }
  };
  const modulePanel = async (entry, ctx) => {
    const installed = manager.installed(entry.id);
    const loaded = registry.get(entry.id);
    const choices = [
      ...!loaded || !config().autoload.includes(entry.id) ? ["enable"] : [],
      ...!installed ? ["install"] : [],
      ...installed && !loaded ? ["load", "load --save"] : [],
      ...loaded || config().autoload.includes(entry.id) ? ["disable"] : [],
      ...loaded ? ["unload"] : [],
      ...installed ? ["update", "uninstall"] : [],
      ...entry.kind === "tool" ? ["set default"] : [],
      ...loaded?.instance.control ? ["settings"] : [],
      ...loaded?.instance.manage ? ["ask", "auto", "reset", "revoke"] : [],
      "status"
    ];
    const action = await ctx.ui.select(
      `${requirements(entry)}
Enable installs only this module; no model calls. Saved control values are retained.`,
      choices
    );
    if (!action) return;
    if (action === "set default") await run(`defaults ${entry.capability} ${entry.provider}`, ctx);
    else await run(`${entry.provider} ${entry.capability}${action === "settings" ? "" : ` ${action}`}`, ctx);
  };
  const subagentsPanel = async (ctx) => {
    const saved = config().subagentModel;
    const available = saved && options.subagents.availableModels(ctx).some((model) => `${model.provider}/${model.id}` === saved);
    const choice = await ctx.ui.select(
      `\u5B50\u4EE3\u7406 / Subagents \xB7 ${options.subagents.isEnabled() ? "\u5DF2\u542F\u7528" : "\u672A\u542F\u7528"}
\u9ED8\u8BA4\u6A21\u578B\uFF1A${saved ?? "\u7EE7\u627F\u5F53\u524D Pi \u6A21\u578B"}${saved && !available ? "\uFF08\u5F53\u524D\u4E0D\u53EF\u7528\uFF09" : ""}`,
      ["\u9009\u62E9\u9ED8\u8BA4\u6A21\u578B", options.subagents.isEnabled() ? "\u7981\u7528" : "\u542F\u7528", "\u72B6\u6001"]
    );
    if (choice === "\u9009\u62E9\u9ED8\u8BA4\u6A21\u578B") await run("subagents model", ctx);
    else if (choice === "\u542F\u7528") await run("subagents enable", ctx);
    else if (choice === "\u7981\u7528") await run("subagents disable", ctx);
    else if (choice === "\u72B6\u6001") await run("subagents status", ctx);
  };
  const panel = async (ctx) => {
    const known = new Set(groups.flatMap((group2) => group2.capabilities));
    const available = [
      ...groups,
      ...manager.catalog.modules.filter((e) => !known.has(e.capability)).map((e) => ({ label: e.capability, capabilities: [e.capability] }))
    ].filter(
      (group2) => group2.label === "\u5B50\u4EE3\u7406 / Subagents" || manager.catalog.modules.some((e) => group2.capabilities.includes(e.capability))
    );
    const selected = await ctx.ui.select("Pi Enhance \xB7 \u6309\u529F\u80FD\u9009\u62E9", [
      ...available.map((g) => g.label),
      "status",
      "catalog",
      "updates",
      "update --installed"
    ]);
    if (!selected) return;
    const group = available.find((g) => g.label === selected);
    if (!group) {
      await run(selected, ctx);
      return;
    }
    if (group.label === "\u5B50\u4EE3\u7406 / Subagents") {
      await subagentsPanel(ctx);
      return;
    }
    const entries = manager.catalog.modules.filter((e) => group.capabilities.includes(e.capability));
    const labels = entries.map((e) => `${e.capability} / ${e.provider} \xB7 ${state(e)}`);
    const choice = await ctx.ui.select(group.label, labels);
    const entry = entries[labels.indexOf(choice ?? "")];
    if (entry) await modulePanel(entry, ctx);
  };
  const run = async (args, ctx) => {
    options.signal().throwIfAborted();
    const words = args.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      if (ctx.mode !== "tui") report(ctx, usage);
      else await panel(ctx);
      return;
    }
    if (words[0] === "subagents") {
      const action2 = words[1];
      if (action2 === "status" && words.length === 2) {
        report(ctx, options.subagents.status(ctx));
        return;
      }
      if (action2 === "model" && words.length <= 3) {
        const models = options.subagents.availableModels(ctx);
        let selected = words[2];
        if (!selected) {
          if (ctx.mode !== "tui")
            throw new Error("Use /pi-enhance subagents model <provider/id>|inherit outside TUI.");
          const inherit = "inherit current Pi model";
          const labels = models.map(
            (model) => `${model.provider}/${model.id} \xB7 ${model.name} \xB7 ${model.input.join("/")} \xB7 ${model.reasoning ? "thinking" : "no thinking"}`
          );
          const choice = await ctx.ui.select(`Subagent default model: ${config().subagentModel ?? inherit}`, [
            inherit,
            ...labels
          ]);
          if (!choice) return;
          if (choice === inherit) selected = "inherit";
          else {
            const model = models[labels.indexOf(choice)];
            if (!model) throw new Error("Invalid model selection; no preference was changed.");
            selected = `${model.provider}/${model.id}`;
          }
        }
        if (selected !== "inherit" && !models.some((model) => `${model.provider}/${model.id}` === selected))
          throw new Error(`Model ${selected} is not enabled and available in this Pi session.`);
        save((c) => {
          if (selected !== "inherit") return { ...c, subagentModel: selected };
          const { subagentModel: _previous, ...rest } = c;
          return rest;
        });
        report(
          ctx,
          `Saved subagent default model: ${selected === "inherit" ? "inherit current Pi model" : selected}. No model calls.`
        );
        return;
      }
      if ((action2 === "enable" || action2 === "disable") && words.length === 2) {
        const enabled = action2 === "enable";
        const previous = options.subagents.isEnabled();
        try {
          options.subagents.setEnabled(enabled);
          refresh(ctx);
          save((c) => ({ ...c, subagents: enabled }));
        } catch (error) {
          options.subagents.setEnabled(previous);
          refresh(ctx);
          throw error;
        }
        if (!enabled) options.subagents.cancelAll();
        report(
          ctx,
          `Subagents ${enabled ? "enabled" : "disabled"}. ${enabled ? "No models are called until call_subagents runs." : "Running batches were cancelled."}`
        );
        return;
      }
      if (action2 === "cancel" && words.length === 3) {
        report(
          ctx,
          options.subagents.cancel(words[2]) ? `Cancellation requested for batch ${words[2]}. Running tasks may still be stopping.` : `No active batch ${words[2]}.`
        );
        return;
      }
      throw new Error(usage);
    }
    if (words[0] === "status" && words.length === 1) {
      report(ctx, await status(ctx));
      return;
    }
    if (words[0] === "catalog" && words.length === 1) {
      report(ctx, manager.catalog.modules.map(requirements).join("\n\n"));
      return;
    }
    if (words[0] === "updates" && words.length === 1) {
      const entries = manager.updates();
      report(
        ctx,
        entries.length ? entries.map(
          (e) => `${e.id}: ${manager.installed(e.id).sha256.slice(0, 12)} \u2192 ${e.sha256.slice(0, 12)} (${(e.bytes / 1024).toFixed(1)} KiB)`
        ).join("\n") : "No updates in this host catalog. Update the pi-enhance package first to obtain a newer catalog."
      );
      return;
    }
    if (words.join(" ") === "update --installed") {
      await update(ctx);
      return;
    }
    if (words[0] === "defaults" && words.length === 3) {
      const [, capability2, provider2] = words;
      if (manager.find(`${capability2}/${provider2}`).kind !== "tool")
        throw new Error("Only tools have default providers.");
      save((c) => ({ ...c, defaults: { ...c.defaults, [capability2]: provider2 } }));
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
    if (!action || action === "manage") {
      if (ctx.mode !== "tui") throw new Error("Explicit action/value required outside TUI.");
      const control = registry.get(id)?.instance.control;
      if (!action && control) {
        const choice = await ctx.ui.select(`${id}: ${config().controls[control.id] ?? "off"}`, [
          ...control.choices
        ]);
        if (choice) await run(`${provider} ${capability} ${choice}`, ctx);
      } else await modulePanel(entry, ctx);
      return;
    }
    if (action === "install") {
      await manager.install(id, options.signal());
      report(
        ctx,
        `Installed ${id}; not loaded by this operation. Run /pi-enhance ${provider} ${capability} enable.`
      );
      return;
    }
    if (action === "update") {
      await update(ctx, [id]);
      return;
    }
    if (action === "enable" || action === "load") {
      if (entry.platforms && !entry.platforms.includes(process.platform))
        throw new Error(`Module requires ${entry.platforms.join(", ")}.`);
      const wasLoaded = !!registry.get(id);
      if (action === "enable" && !manager.installed(id)) await manager.install(id, options.signal());
      options.signal().throwIfAborted();
      await load(id, ctx);
      try {
        if (persist || action === "enable") setAutoload(id, true);
      } catch (error) {
        if (!wasLoaded) {
          await registry.unload(id);
          refresh(ctx);
        }
        throw error;
      }
      report(
        ctx,
        `${action === "enable" ? "Enabled" : "Loaded"} ${id}${persist || action === "enable" ? "; saved for future Pi sessions" : "; session only"}. No model calls. Saved control values retained.${entry.auth ? ` Auth required: ${entry.auth.provider}/${entry.auth.channel}; use /login and status to check readiness.` : ""}`
      );
      return;
    }
    if (action === "disable" || action === "unload" || action === "uninstall") {
      await remove(id, ctx, persist || action !== "unload", action === "uninstall");
      report(
        ctx,
        `${action}: ${id}. Historical artifacts retained.${action === "disable" ? " Installation and control preferences retained." : ""}`
      );
      return;
    }
    if (action === "status") {
      report(ctx, await status(ctx, entry));
      return;
    }
    const instance = registry.get(id)?.instance;
    if (!instance) throw new Error(`Load ${id} first. No implicit downloads or loading.`);
    if (instance.control) {
      const control = instance.control, value = control.aliases?.[action] ?? action;
      if (!control.choices.includes(value)) throw new Error(`Choose ${control.choices.join(" / ")}`);
      save((c) => ({ ...c, controls: { ...c.controls, [control.id]: value } }));
      refresh(ctx);
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
  let busy = false;
  pi.registerCommand("pi-enhance", {
    description: "Optional capabilities: browse, enable, disable and update installed modules",
    getArgumentCompletions(prefix) {
      const candidates = [
        "status",
        "catalog",
        "updates",
        "update --installed",
        "subagents enable",
        "subagents disable",
        "subagents status",
        "subagents model",
        "subagents model inherit",
        ...manager.catalog.modules.flatMap(
          (e) => [
            "",
            "enable",
            "disable",
            "install",
            "load",
            "load --save",
            "unload",
            "unload --save",
            "uninstall",
            "update",
            "status",
            "manage",
            ...e.kind === "request-control" ? e.capability === "verbosity" ? ["off", "low", "medium", "high"] : ["off", "on"] : e.capability === "use_computer" ? ["ask", "auto", "reset", "revoke"] : []
          ].map((a) => `${e.provider} ${e.capability}${a ? ` ${a}` : ""}`)
        ),
        ...manager.catalog.modules.filter((e) => e.kind === "tool").map((e) => `defaults ${e.capability} ${e.provider}`)
      ];
      const items = candidates.filter((c) => c.startsWith(prefix.trimStart())).map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (busy) {
        report(ctx, "Another pi-enhance operation is running. Retry after it finishes.", true);
        return;
      }
      busy = true;
      try {
        await ctx.waitForIdle();
        await run(args, ctx);
      } catch (error) {
        report(ctx, errorText(error), true);
      } finally {
        busy = false;
      }
    }
  });
}

// packages/hosts/pi/src/subagents/index.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { Type as Type2 } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";

// packages/hosts/pi/src/subagents/runner.ts
import { join as join3 } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager
} from "@earendil-works/pi-coding-agent";
async function runSubagent(task, index, model, thinkingLevel, registry, parentRegistry, signal, onProgress) {
  const cwd = task.cwd ?? process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: true } });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join3(agentDir, "auth.json"),
    modelsPath: join3(agentDir, "models.json"),
    allowModelNetwork: false
  });
  for (const providerId of parentRegistry.getRegisteredProviderIds()) {
    const native = parentRegistry.getRegisteredNativeProvider(providerId);
    const config = parentRegistry.getRegisteredProviderConfig(providerId);
    if (native) modelRuntime.registerNativeProvider(native);
    else if (config) modelRuntime.registerProvider(providerId, config);
  }
  const requestedModel = modelRuntime.getModel(model.provider, model.id);
  if (!requestedModel)
    throw new Error(`Model ${model.provider}/${model.id} cannot be reconstructed in an isolated Pi session.`);
  const enhanced = new Map(registry.tools().map((tool2) => [tool2.name, tool2]));
  const customTools = (task.tools ?? []).filter((name) => enhanced.has(name)).map((name) => {
    const tool2 = enhanced.get(name);
    return {
      ...tool2,
      execute: (id, args, toolSignal, update, ctx) => {
        const context = {
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          host: "pi",
          credentials: new PiCredentialResolver(ctx.modelRegistry),
          signal: toolSignal,
          model: ctx.model ? {
            id: ctx.model.id,
            provider: ctx.model.provider === "openai-codex" ? "openai" : ctx.model.provider,
            channel: ctx.model.provider === "openai-codex" ? "codex" : void 0,
            api: ctx.model.api === "openai-codex-responses" ? "codex-responses" : ctx.model.api,
            input: ctx.model.input
          } : void 0,
          history: piHistory(ctx.sessionManager.buildContextEntries())
        };
        return tool2.execute(id, args, toolSignal, update, context);
      }
    };
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: requestedModel,
    thinkingLevel,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    tools: task.tools ?? [],
    customTools,
    excludeTools: ["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"]
  });
  let turns = 0;
  let limit;
  const usage2 = { input: 0, output: 0, cost: 0 };
  let phase = "starting";
  let tool;
  const recent = [];
  const report = () => onProgress?.({ phase, tool, turns, usage: { ...usage2 }, recent: recent.map((entry) => ({ ...entry })) });
  const updateRecent = (source, text, name, append = false) => {
    if (!text) return;
    const previous = recent.at(-1);
    if (append && previous?.source === source && previous.tool === name)
      previous.text = (previous.text + text).slice(-500);
    else {
      recent.push({ source, tool: name, text: text.slice(-500) });
      if (recent.length > 3) recent.shift();
    }
    report();
  };
  const toolText = (result) => {
    if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content))
      return "";
    return result.content.filter(
      (item) => item?.type === "text" && typeof item.text === "string"
    ).map((item) => item.text.slice(-500)).join("\n").slice(-500);
  };
  let timer;
  const abort = (reason) => {
    if (limit) return;
    limit = reason;
    void session.abort();
  };
  const onAbort = () => abort("cancelled");
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      if (task.max_turns && turns >= task.max_turns) abort("max_turns");
      else {
        phase = "thinking";
        tool = void 0;
        report();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
      updateRecent("assistant", event.assistantMessageEvent.delta, void 0, true);
    if (event.type === "tool_execution_start") {
      phase = "tool";
      tool = event.toolName;
      report();
    }
    if (event.type === "tool_execution_update")
      updateRecent("tool", toolText(event.partialResult), event.toolName);
    if (event.type === "tool_execution_end") {
      updateRecent("tool", toolText(event.result), event.toolName);
      phase = "thinking";
      tool = void 0;
      report();
    }
    if (event.type === "turn_end") {
      turns++;
      report();
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      usage2.input += event.message.usage?.input ?? 0;
      usage2.output += event.message.usage?.output ?? 0;
      usage2.cost += event.message.usage?.cost?.total ?? 0;
      report();
    }
  });
  try {
    report();
    await session.bindExtensions({ mode: "print" });
    const actual = new Set(session.getActiveToolNames());
    for (const name of task.tools ?? [])
      if (!actual.has(name)) throw new Error(`Tool ${name} is unavailable in the child Pi session.`);
    if (signal.aborted) abort("cancelled");
    else signal.addEventListener("abort", onAbort, { once: true });
    if (task.timeout_seconds) timer = setTimeout(() => abort("timeout"), task.timeout_seconds * 1e3);
    if (!limit) await session.prompt(task.context, { expandPromptTemplates: false });
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    const text = session.getLastAssistantText() || last?.errorMessage || "(no output)";
    return {
      index,
      model: `${model.provider}/${model.id}`,
      status: limit ?? (last?.stopReason === "error" || last?.stopReason === "aborted" ? "failed" : "completed"),
      text,
      turns,
      usage: usage2
    };
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    unsubscribe();
    session.dispose();
  }
}

// packages/hosts/pi/src/subagents/index.ts
var TaskSchema = Type2.Object(
  {
    context: Type2.String({
      minLength: 1,
      maxLength: 1e5,
      description: "Complete task and context for this independent Pi agent. The parent transcript is not copied."
    }),
    tools: Type2.Optional(
      Type2.Array(Type2.String(), {
        maxItems: 32,
        description: "Exact Pi tool names. Omit or use [] for no tools. Only currently active parent tools may be requested."
      })
    ),
    model: Type2.Optional(
      Type2.String({
        description: "Exact provider/model-id from view_subagent_models. Overrides the saved subagent default; otherwise inherits the current Pi model."
      })
    ),
    thinking_level: Type2.Optional(
      Type2.Union(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((x) => Type2.Literal(x))
      )
    ),
    cwd: Type2.Optional(
      Type2.String({
        description: "Child working directory; defaults to the parent cwd. Not a filesystem sandbox."
      })
    ),
    timeout_seconds: Type2.Optional(
      Type2.Integer({
        minimum: 1,
        maximum: 2147483,
        description: "Optional wall-clock limit. Omitted means no agent-enhance time limit."
      })
    ),
    max_turns: Type2.Optional(
      Type2.Integer({
        minimum: 1,
        maximum: 1e6,
        description: "Optional Pi agent-turn limit. Omitted means no agent-enhance turn limit."
      })
    )
  },
  { additionalProperties: false }
);
var CallSchema = Type2.Object(
  { tasks: Type2.Array(TaskSchema, { minItems: 1, maxItems: 8 }) },
  { additionalProperties: false }
);
var ModelsSchema = Type2.Object(
  {
    query: Type2.Optional(Type2.String({ description: "Filter by provider, ID or name" })),
    input: Type2.Optional(Type2.Union([Type2.Literal("text"), Type2.Literal("image")])),
    reasoning: Type2.Optional(Type2.Boolean()),
    offset: Type2.Optional(Type2.Integer({ minimum: 0 }))
  },
  { additionalProperties: false }
);
var ViewSchema = Type2.Object(
  {
    batchId: Type2.Optional(Type2.String({ description: "Batch ID returned by call_subagents" })),
    id: Type2.Optional(Type2.String({ description: "Task ID returned by call_subagents or view_subagents" }))
  },
  { additionalProperties: false }
);
var CancelSchema = Type2.Object(
  { batchId: Type2.String({ minLength: 1, description: "Batch ID to cancel" }) },
  { additionalProperties: false }
);
var HOST_TOOLS = /* @__PURE__ */ new Set(["call_subagents", "view_subagent_models", "view_subagents", "cancel_subagents"]);
var EFFECTFUL = /* @__PURE__ */ new Set([
  "edit",
  "write",
  "bash",
  "powershell",
  "gen_image",
  "gen_video",
  "gen_voice",
  "use_computer"
]);
var BUILTIN = /* @__PURE__ */ new Set(["read", "grep", "find", "ls", "edit", "write", "bash", "powershell"]);
var LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function thinkingLevels(model) {
  if (!model.reasoning) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    return mapped !== null && (level !== "xhigh" && level !== "max" || mapped !== void 0);
  });
}
var PAGE_SIZE = 30;
var MAX_RUNNING = 4;
var MAX_QUEUED = 32;
var OUTPUT_CHARS = 12e3;
var PREVIEW_CHARS = 400;
var HISTORY_LIMIT = 24;
var Subagents = class {
  constructor(pi, registry, runner = runSubagent) {
    this.pi = pi;
    this.registry = registry;
    this.runner = runner;
    pi.registerMessageRenderer("pi-enhance:subagents", (message, { expanded, outputPad }, theme) => {
      const details = message.details;
      const results = details?.results ?? [];
      const good = results.filter((r) => r.status === "completed").length;
      const lines = [
        theme.fg("accent", theme.bold("SUBAGENTS")) + theme.fg("muted", `  ${details?.batchId ?? "batch"}`)
      ];
      lines.push(
        theme.fg(
          results.length && good === results.length ? "success" : "warning",
          results.length ? `${good}/${results.length} completed` : "Batch error"
        ) + theme.fg(
          "muted",
          ` \xB7 ${results.length ? "final results" : "details"}${details?.elapsedMs !== void 0 ? ` \xB7 ${(details.elapsedMs / 1e3).toFixed(1)}s` : ""}`
        )
      );
      for (const result of results) {
        const color = result.status === "completed" ? "success" : "warning";
        lines.push(
          theme.fg(
            color,
            `${result.status === "completed" ? "\u2713" : "!"} Task ${result.index + 1} \xB7 ${result.status}`
          ) + theme.fg("muted", ` \xB7 ${result.model} \xB7 ${result.turns} turns`)
        );
        if (expanded) {
          lines.push(
            theme.fg(
              "muted",
              `  id ${details?.taskIds?.[result.index] ?? "\u2014"} \xB7 ${details?.taskElapsedMs?.[result.index] === void 0 ? "\u2014" : `${(details.taskElapsedMs[result.index] / 1e3).toFixed(1)}s`} \xB7 ${result.usage.input} in / ${result.usage.output} out \xB7 $${result.usage.cost.toFixed(4)}`
            )
          );
          lines.push(result.text.slice(0, OUTPUT_CHARS));
        } else lines.push(theme.fg("dim", result.text.replace(/\s+/g, " ").slice(0, 160)));
      }
      if (!results.length)
        lines.push(
          typeof message.content === "string" ? message.content.slice(0, expanded ? 2500 : 300) : "(no results)"
        );
      const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(lines.join("\n"), 0, 0));
      return box;
    });
  }
  batches = /* @__PURE__ */ new Map();
  history = /* @__PURE__ */ new Map();
  renderWatchers = /* @__PURE__ */ new Map();
  pendingRenders = /* @__PURE__ */ new Map();
  renderTimer;
  activeRunners = 0;
  waiters = [];
  owner;
  enabled = false;
  defaultModel;
  closed = false;
  setEnabled(enabled) {
    this.enabled = enabled;
  }
  isEnabled() {
    return this.enabled;
  }
  setDefaultModel(model) {
    this.defaultModel = model;
  }
  getDefaultModel() {
    return this.defaultModel;
  }
  startSession(sessionId) {
    if (this.owner && this.owner !== sessionId) this.cancelAll();
    this.owner = sessionId;
    this.closed = false;
  }
  cancelAll() {
    for (const batch of this.batches.values()) batch.controller.abort();
    this.batches.clear();
    this.history.clear();
    this.renderWatchers.clear();
    for (const timer of this.pendingRenders.values()) clearTimeout(timer);
    this.pendingRenders.clear();
    this.stopRenderTimer();
  }
  shutdown() {
    this.closed = true;
    this.cancelAll();
    this.owner = void 0;
  }
  cancel(id) {
    const batch = this.batches.get(id);
    if (!batch) return false;
    batch.controller.abort();
    for (const state of batch.states) {
      if (state.status === "queued") {
        state.status = "cancelled";
        state.finishedAt = Date.now();
      } else if (state.status === "running") state.status = "cancelling";
    }
    this.notifyRender(batch.id);
    return true;
  }
  stopRenderTimer() {
    if (this.renderTimer) clearInterval(this.renderTimer);
    this.renderTimer = void 0;
  }
  notifyRender(id) {
    const pending = this.pendingRenders.get(id);
    if (pending) clearTimeout(pending);
    this.pendingRenders.delete(id);
    for (const invalidate of this.renderWatchers.get(id) ?? []) invalidate();
  }
  scheduleRender(id) {
    if (!this.renderWatchers.has(id) || this.pendingRenders.has(id)) return;
    const timer = setTimeout(() => this.notifyRender(id), 200);
    timer.unref();
    this.pendingRenders.set(id, timer);
  }
  watchRender(id, invalidate) {
    let watchers = this.renderWatchers.get(id);
    if (!watchers) {
      watchers = /* @__PURE__ */ new Set();
      this.renderWatchers.set(id, watchers);
    }
    watchers.add(invalidate);
    if (!this.renderTimer) {
      this.renderTimer = setInterval(() => {
        for (const batchId of this.renderWatchers.keys()) this.notifyRender(batchId);
      }, 1e3);
      this.renderTimer.unref();
    }
  }
  finishRender(id) {
    this.notifyRender(id);
    this.renderWatchers.delete(id);
    if (!this.renderWatchers.size) this.stopRenderTimer();
  }
  status(ctx) {
    const selected = this.defaultModel;
    const availability = selected && ctx ? this.availableModels(ctx).some((model) => `${model.provider}/${model.id}` === selected) ? "available" : "unavailable in this Pi session" : void 0;
    return `Subagents: ${this.enabled ? "enabled" : "disabled"}; default model: ${selected ?? "inherit current Pi model"}${availability ? ` (${availability})` : ""}; running: ${this.activeRunners}; active batches: ${[...this.batches.keys()].join(", ") || "none"}. Background results return to the originating session.`;
  }
  assertModuleIdle(capability) {
    if ([...this.batches.values()].some(
      (batch) => batch.tasks.some(({ task }) => task.tools?.includes(capability))
    ))
      throw new Error(`Subagents are using ${capability}; cancel or wait for the batch before unloading.`);
  }
  releaseSlot() {
    const next = this.waiters.shift();
    if (next)
      next();
    else this.activeRunners--;
  }
  async slot(signal) {
    if (signal.aborted) throw new Error("Batch cancelled.");
    if (this.activeRunners < MAX_RUNNING) this.activeRunners++;
    else {
      await new Promise((resolve2, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", cancel);
          resolve2();
        };
        const cancel = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Batch cancelled."));
        };
        this.waiters.push(wake);
        signal.addEventListener("abort", cancel, { once: true });
      });
      if (signal.aborted) {
        this.releaseSlot();
        throw new Error("Batch cancelled.");
      }
    }
    return () => this.releaseSlot();
  }
  tools() {
    return this.enabled ? [this.modelsTool(), this.callTool(), this.viewTool(), this.cancelTool()] : [];
  }
  availableModels(ctx) {
    const available = ctx.modelRegistry.getAvailable();
    const scoped = ctx.scopedModels?.length ? new Set(ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`)) : void 0;
    return available.filter((model) => !scoped || scoped.has(`${model.provider}/${model.id}`));
  }
  modelsTool() {
    return {
      name: "view_subagent_models",
      label: "Subagent Models",
      description: "View models enabled and available in the current Pi session, including text/image input and reasoning metadata. Read-only, no model call. Use exact provider/model-id in call_subagents; omit model to use the saved subagent default or current Pi model.",
      parameters: ModelsSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const query = args.query?.toLowerCase() ?? "";
        const models = this.availableModels(ctx).filter(
          (model) => (!query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query)) && (!args.input || model.input.includes(args.input)) && (args.reasoning === void 0 || model.reasoning === args.reasoning)
        );
        const offset = args.offset ?? 0;
        const page = models.slice(offset, offset + PAGE_SIZE).map((model) => ({
          model: `${model.provider}/${model.id}`,
          name: model.name,
          input: model.input,
          reasoning: model.reasoning,
          thinking_levels: thinkingLevels(model),
          current: ctx.model?.provider === model.provider && ctx.model?.id === model.id,
          default: this.defaultModel === `${model.provider}/${model.id}`
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total: models.length,
                  default_model: this.defaultModel ?? null,
                  offset,
                  next_offset: offset + PAGE_SIZE < models.length ? offset + PAGE_SIZE : null,
                  models: page
                },
                null,
                2
              )
            }
          ],
          details: { total: models.length }
        };
      }
    };
  }
  callTool() {
    return {
      name: "call_subagents",
      label: "Call Subagents",
      promptSnippet: "Delegate substantial independent investigations, parallel subtasks, or useful second opinions to isolated Pi agents; handle trivial questions directly.",
      promptGuidelines: [
        "Consider call_subagents when independent or parallel work justifies extra model usage. Give each child self-contained context and only the tools it needs; wait for the background completion before relying on its findings."
      ],
      description: "Create 1\u20138 independent Pi agents in the background. Each task needs context; tools are optional (omitted = no tools). Model priority: explicit task.model, saved subagent default, current Pi model. Thinking inherits the current Pi session unless specified. Only models enabled in the current Pi session and tools active in the parent are allowed. Pi and pi-enhance write/effectful tools require explicit user approval; unknown extension tools are unsupported. No implicit timeout or turn limit. Results return as a separate session message after completion; no progress stream. Never retry side effects automatically.",
      parameters: CallSchema,
      renderCall: (args, theme) => new Text(
        [
          theme.fg("toolTitle", theme.bold("SUBAGENTS")) + theme.fg("muted", ` \xB7 launching ${args.tasks.length} task(s)`),
          ...args.tasks.map(
            (task, index) => theme.fg("accent", `  ${index + 1}. `) + theme.fg("dim", task.context.replace(/\s+/g, " ").slice(0, 100)) + (task.model ? theme.fg("muted", ` \xB7 ${task.model}`) : "")
          )
        ].join("\n"),
        0,
        0
      ),
      renderResult: (result, { expanded }, theme, context) => {
        const details = result.details;
        if (!details?.batchId)
          return new Text(
            theme.fg("warning", result.content.find((c) => c.type === "text")?.text ?? "Failed to start"),
            0,
            0
          );
        const batch = this.batches.get(details.batchId) ?? this.history.get(details.batchId);
        if (!batch)
          return new Text(
            theme.fg("muted", `Subagents \xB7 batch ${details.batchId} \xB7 no longer in this session`),
            0,
            0
          );
        if (this.batches.has(batch.id) && !context.state.subagentWatcher) {
          context.state.subagentWatcher = () => context.invalidate();
          this.watchRender(batch.id, context.state.subagentWatcher);
        }
        const now = Date.now();
        const elapsed = ((batch.finishedAt ?? now) - batch.createdAt) / 1e3;
        const completed = batch.states.filter((state) => state.status === "completed").length;
        const usage2 = batch.states.reduce(
          (total, state, index) => {
            const value = batch.results[index]?.usage ?? state.progress?.usage;
            total.input += value?.input ?? 0;
            total.output += value?.output ?? 0;
            total.cost += value?.cost ?? 0;
            return total;
          },
          { input: 0, output: 0, cost: 0 }
        );
        const lines = [
          theme.fg("accent", theme.bold("SUBAGENTS")) + theme.fg("muted", ` \xB7 ${batch.id}`),
          theme.fg(
            batch.finishedAt ? "success" : "warning",
            `${completed}/${batch.states.length} completed`
          ) + theme.fg(
            "muted",
            ` \xB7 ${elapsed.toFixed(1)}s \xB7 ${usage2.input} in / ${usage2.output} out \xB7 $${usage2.cost.toFixed(4)} settled`
          )
        ];
        for (let index = 0; index < batch.states.length; index++) {
          const state = batch.states[index];
          const latest = state.progress?.recent.at(-1);
          const seconds = state.startedAt ? ((state.finishedAt ?? now) - state.startedAt) / 1e3 : 0;
          lines.push(
            theme.fg(
              state.status === "completed" ? "success" : state.status === "failed" || state.status === "cancelled" ? "error" : "accent",
              `  ${index + 1}. ${state.status}`
            ) + theme.fg(
              "muted",
              ` \xB7 ${seconds.toFixed(1)}s${state.progress?.tool ? ` \xB7 ${state.progress.tool}` : ""}`
            )
          );
          if (expanded) {
            lines.push(
              theme.fg(
                "dim",
                `     ${state.id} \xB7 ${batch.results[index]?.usage.input ?? state.progress?.usage.input ?? 0} in / ${batch.results[index]?.usage.output ?? state.progress?.usage.output ?? 0} out`
              )
            );
            if (latest?.text)
              lines.push(
                theme.fg(
                  "dim",
                  `     ${latest.source}${latest.tool ? `/${latest.tool}` : ""}: ${latest.text.replace(/\s+/g, " ").slice(-180)}`
                )
              );
          } else if (latest?.text)
            lines.push(theme.fg("dim", `     ${latest.text.replace(/\s+/g, " ").slice(-100)}`));
        }
        return new Text(lines.join("\n"), 0, 0);
      },
      execute: async (_id, args, signal, _update, ctx) => {
        if (!this.enabled || this.closed) throw new Error("Subagents are disabled or the session has ended.");
        signal?.throwIfAborted();
        const models = this.availableModels(ctx);
        const active = new Set(this.pi.getActiveTools());
        const enhanced = new Set(this.registry.tools().map((tool) => tool.name));
        const approved = /* @__PURE__ */ new Set();
        const prepared = [];
        for (const task of args.tasks) {
          const requestedModel = task.model ?? this.defaultModel;
          const model = requestedModel ? models.find((m) => `${m.provider}/${m.id}` === requestedModel) : ctx.model && models.find((m) => m.provider === ctx.model?.provider && m.id === ctx.model?.id);
          if (!model)
            throw new Error(
              `Model ${requestedModel ?? "(current)"} is not enabled and available in this Pi session. Use view_subagent_models or change /pi-enhance subagents model.`
            );
          if (task.thinking_level && !thinkingLevels(model).includes(task.thinking_level))
            throw new Error(
              `Thinking level ${task.thinking_level} is unsupported by ${model.provider}/${model.id}.`
            );
          const names = task.tools ?? [];
          if (new Set(names).size !== names.length) throw new Error("Duplicate tool names in one task.");
          for (const name of names) {
            if (HOST_TOOLS.has(name) || !active.has(name))
              throw new Error(`Tool ${name} is not active in the parent Pi session.`);
            if (!BUILTIN.has(name) && !enhanced.has(name))
              throw new Error(`Tool ${name} cannot be safely reconstructed in a child session.`);
            if (EFFECTFUL.has(name)) approved.add(name);
          }
          prepared.push({ task, model, thinking: task.thinking_level ?? ctx.thinkingLevel ?? "off" });
        }
        if (approved.size) {
          if (!ctx.hasUI)
            throw new Error(
              `Subagent write/effectful tools are blocked without interactive user approval: ${[...approved].join(", ")}.`
            );
          const ok = await ctx.ui.confirm(
            "Allow subagent side effects?",
            `These child agents may use ${[...approved].join(", ")}. Bash/PowerShell can bypass file restrictions; generation saves artifacts and can consume quota. Approve this batch only?`
          );
          if (!ok) throw new Error("Subagent write/effectful tools were not approved.");
        }
        signal?.throwIfAborted();
        if ([...this.batches.values()].reduce(
          (count, batch2) => count + batch2.tasks.length - batch2.results.filter(Boolean).length,
          0
        ) + prepared.length > MAX_QUEUED)
          throw new Error("Subagent queue is full; wait for existing batches to finish.");
        const owner = ctx.sessionManager.getSessionId();
        if (this.owner !== owner) throw new Error("Session changed while preparing subagents.");
        const batch = {
          id: randomUUID3(),
          createdAt: Date.now(),
          states: prepared.map(() => ({ id: randomUUID3(), status: "queued" })),
          owner,
          anchor: ctx.sessionManager.getLeafId(),
          sessionManager: ctx.sessionManager,
          controller: new AbortController(),
          tasks: prepared,
          modelRegistry: ctx.modelRegistry,
          results: []
        };
        this.batches.set(batch.id, batch);
        void this.run(batch).catch((error) => {
          this.finishRender(batch.id);
          this.batches.delete(batch.id);
          if (!this.closed && this.owner === owner && !batch.controller.signal.aborted)
            this.publish(
              batch,
              `Batch ${batch.id} failed: ${error instanceof Error ? error.message : String(error)}`
            );
        });
        return {
          content: [
            {
              type: "text",
              text: `Started ${prepared.length} subagent task(s); batch ${batch.id}; task IDs: ${batch.states.map((state) => state.id).join(", ")}. Continue other work. Use view_subagents to check progress or cancel_subagents to cancel. A completion message will be delivered to this session.`
            }
          ],
          details: {
            batchId: batch.id,
            taskIds: batch.states.map((state) => state.id),
            tasks: prepared.length
          }
        };
      }
    };
  }
  taskView(batch, index, full = false) {
    const state = batch.states[index];
    const result = batch.results[index];
    const now = Date.now();
    return {
      id: state.id,
      index: index + 1,
      status: state.status,
      phase: state.status === "running" || state.status === "cancelling" ? state.progress?.phase ?? "starting" : void 0,
      current_tool: state.status === "running" || state.status === "cancelling" ? state.progress?.tool : void 0,
      recent_output: state.progress?.recent?.filter((entry) => entry.text) ?? [],
      model: `${batch.tasks[index].model.provider}/${batch.tasks[index].model.id}`,
      context_preview: batch.tasks[index].task.context.replace(/\s+/g, " ").slice(0, 160),
      started_at: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      elapsed_ms: state.startedAt ? (state.finishedAt ?? now) - state.startedAt : 0,
      turns: result?.turns ?? state.progress?.turns ?? 0,
      usage: result?.usage ?? state.progress?.usage ?? { input: 0, output: 0, cost: 0 },
      result: result ? result.text.slice(0, full ? OUTPUT_CHARS : PREVIEW_CHARS) : void 0,
      truncated: result ? result.text.length > (full ? OUTPUT_CHARS : PREVIEW_CHARS) : void 0
    };
  }
  batchView(batch, full = false) {
    return {
      batchId: batch.id,
      created_at: new Date(batch.createdAt).toISOString(),
      finished_at: batch.finishedAt ? new Date(batch.finishedAt).toISOString() : null,
      total: batch.states.length,
      counts: Object.fromEntries(
        ["queued", "running", "cancelling", "completed", "failed", "cancelled", "timeout", "max_turns"].map(
          (status) => [status, batch.states.filter((state) => state.status === status).length]
        )
      ),
      tasks: full ? batch.states.map((_, index) => this.taskView(batch, index)) : void 0
    };
  }
  viewTool() {
    return {
      name: "view_subagents",
      label: "View Subagents",
      description: "Read-only current-session progress. With no arguments, list batches; with batchId, show task progress; with id, show one task and its final result. Recent visible assistant text and tool output are bounded to three snippets of 500 characters; reasoning is never included. Completed batches are retained for this session (latest 24).",
      parameters: ViewSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const batches = [...this.batches.values(), ...this.history.values()].filter(
          (batch) => batch.owner === ctx.sessionManager.getSessionId() && this.onBranch(batch)
        );
        let data;
        if (args.id) {
          const batch = batches.find((item) => item.states.some((state) => state.id === args.id));
          if (!batch || args.batchId && batch.id !== args.batchId)
            throw new Error("Subagent task not found in this session/branch.");
          data = {
            batchId: batch.id,
            task: this.taskView(
              batch,
              batch.states.findIndex((state) => state.id === args.id),
              true
            )
          };
        } else if (args.batchId) {
          const batch = batches.find((item) => item.id === args.batchId);
          if (!batch) throw new Error("Subagent batch not found in this session/branch.");
          data = this.batchView(batch, true);
        } else data = { batches: batches.map((batch) => this.batchView(batch)) };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
      }
    };
  }
  cancelTool() {
    return {
      name: "cancel_subagents",
      label: "Cancel Subagents",
      description: "Request cancellation of an active batch by batchId. Running tasks show cancelling until their model/tool acknowledges abort and settles; queued tasks are cancelled immediately. No automatic retry.",
      parameters: CancelSchema,
      execute: async (_id, args, _signal, _update, ctx) => {
        const batch = this.batches.get(args.batchId);
        if (!batch || batch.owner !== ctx.sessionManager.getSessionId() || !this.onBranch(batch))
          throw new Error("Active subagent batch not found in this session/branch.");
        this.cancel(args.batchId);
        return {
          content: [
            {
              type: "text",
              text: `Cancellation requested for batch ${args.batchId}. Use view_subagents to inspect final state.`
            }
          ],
          details: { batchId: args.batchId, cancelled: true }
        };
      }
    };
  }
  async run(batch) {
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_RUNNING, batch.tasks.length) }, async () => {
      while (next < batch.tasks.length && !batch.controller.signal.aborted) {
        const index = next++;
        const { task, model, thinking } = batch.tasks[index];
        let release;
        try {
          release = await this.slot(batch.controller.signal);
          const state = batch.states[index];
          if (batch.controller.signal.aborted) throw new Error("Batch cancelled.");
          state.status = "running";
          state.startedAt = Date.now();
          batch.results[index] = await this.runner(
            task,
            index,
            model,
            thinking,
            this.registry,
            batch.modelRegistry,
            batch.controller.signal,
            (progress) => {
              state.progress = progress;
              this.scheduleRender(batch.id);
            }
          );
          state.status = batch.controller.signal.aborted ? "cancelled" : batch.results[index].status;
          if (batch.controller.signal.aborted) batch.results[index].status = "cancelled";
          state.finishedAt = Date.now();
        } catch (error) {
          const state = batch.states[index];
          state.status = batch.controller.signal.aborted ? "cancelled" : "failed";
          state.finishedAt = Date.now();
          batch.results[index] = {
            index,
            model: `${model.provider}/${model.id}`,
            status: state.status,
            text: error instanceof Error ? error.message : String(error),
            turns: state.progress?.turns ?? 0,
            usage: state.progress?.usage ?? { input: 0, output: 0, cost: 0 }
          };
        } finally {
          release?.();
        }
      }
    });
    await Promise.all(workers);
    for (let index = 0; index < batch.states.length; index++) {
      const state = batch.states[index];
      if (state.status === "queued") {
        state.status = "cancelled";
        state.finishedAt = Date.now();
      }
      if (!batch.results[index])
        batch.results[index] = {
          index,
          model: `${batch.tasks[index].model.provider}/${batch.tasks[index].model.id}`,
          status: "cancelled",
          text: "Cancelled before starting.",
          turns: 0,
          usage: { input: 0, output: 0, cost: 0 }
        };
    }
    batch.finishedAt = Date.now();
    this.finishRender(batch.id);
    const stillTracked = this.batches.delete(batch.id);
    if (!stillTracked || this.closed || this.owner !== batch.owner || !this.onBranch(batch)) return;
    this.history.set(batch.id, batch);
    if (this.history.size > HISTORY_LIMIT) this.history.delete(this.history.keys().next().value);
    if (batch.controller.signal.aborted) return;
    const lines = batch.results.map(
      (result) => `### Task ${result.index + 1} \xB7 ${result.model} \xB7 ${result.status}
${result.text.slice(0, OUTPUT_CHARS)}${result.text.length > OUTPUT_CHARS ? "\n[Output truncated]" : ""}
Turns: ${result.turns}; tokens: ${result.usage.input} in / ${result.usage.output} out; cost: $${result.usage.cost.toFixed(4)}`
    );
    this.publish(batch, `Batch ${batch.id} completed.

${lines.join("\n\n---\n\n")}`);
  }
  onBranch(batch) {
    return batch.sessionManager.getSessionId() === batch.owner && (!batch.anchor || batch.sessionManager.getBranch().some((entry) => entry.id === batch.anchor));
  }
  publish(batch, content) {
    if (this.closed || !this.onBranch(batch)) return;
    this.pi.sendMessage(
      {
        customType: "pi-enhance:subagents",
        content,
        display: true,
        details: {
          batchId: batch.id,
          results: batch.results,
          taskIds: batch.states.map((state) => state.id),
          elapsedMs: (batch.finishedAt ?? Date.now()) - batch.createdAt,
          taskElapsedMs: batch.states.map(
            (state) => state.startedAt ? (state.finishedAt ?? Date.now()) - state.startedAt : 0
          )
        }
      },
      { triggerTurn: true, deliverAs: "followUp" }
    );
  }
};

// packages/hosts/pi/src/index.ts
var command = "pi-enhance";
var releaseGuidance = "When changing agent-enhance/pi-enhance for installation in Pi, follow the repository's docs/release.md: run checks, commit and push to https://github.com/Ezio2000/agent-enhance, then install or update Pi from that Git remote. Never persistently install the local working tree. If pushing is not authorized or fails, ask or stop rather than substituting a local installation.";
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
  const subagents = new Subagents(pi, registry);
  subagents.setEnabled(config.subagents === true);
  subagents.setDefaultModel(config.subagentModel);
  let previousProvider;
  let disposed = false;
  let operations = new AbortController();
  let registered = /* @__PURE__ */ new Set();
  const knownNames = /* @__PURE__ */ new Set();
  let footerLabels = [];
  const report = (ctx, text, error = false) => {
    if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
    else {
      pi.sendMessage({ customType: "pi-enhance", content: text, display: true }, { triggerTurn: false });
      if (ctx.mode === "print") console.log(text);
    }
  };
  const statusLine = (ctx) => {
    const model = modelInfo(ctx.model);
    footerLabels = registry.list().filter((e) => {
      const control = e.instance.control;
      return control && model?.provider === "openai" && model.channel === "codex" && model.api === "codex-responses" && control.supported(model);
    }).map((e) => {
      const control = e.instance.control, value = config.controls[control.id] ?? "off";
      return {
        id: control.id,
        value: control.formatValue ? control.formatValue(value, model) : value,
        active: value !== "off"
      };
    });
    if (ctx.hasUI)
      ctx.ui.setStatus(
        command,
        footerLabels.length ? footerLabels.map((l) => `${l.id}:${l.value}`).join(" ") : void 0
      );
  };
  const excludedCapabilities = (ctx) => {
    const input = modelInfo(ctx.model)?.input;
    if (!input?.length) return /* @__PURE__ */ new Set();
    return new Set(
      registry.list().filter(
        (e) => e.instance.tool && e.module.manifest.modelInputExcludes?.some((modality) => input.includes(modality))
      ).map((e) => e.module.manifest.capability)
    );
  };
  const refresh = (ctx) => {
    const excluded = excludedCapabilities(ctx);
    const hostTools = subagents.tools();
    const tools = [...registry.tools().filter((tool) => !excluded.has(tool.name)), ...hostTools];
    const active = new Set(pi.getActiveTools());
    for (const tool of tools) {
      const collision = pi.getAllTools().find((t) => t.name === tool.name);
      if (collision && !knownNames.has(tool.name))
        throw new Error(`Tool collision: ${tool.name}; disable the conflicting extension first.`);
      const hostTool = hostTools.find((candidate) => candidate.name === tool.name);
      if (hostTool) pi.registerTool(hostTool);
      else {
        const capabilityTool = tool;
        pi.registerTool({
          ...capabilityTool,
          execute: (id, args, signal, update, piContext) => capabilityTool.execute(id, args, signal, update, executionContext(piContext))
        });
      }
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
  const activate = async (module, ctx) => {
    const manifest = module.manifest, id = manifest.id;
    registry.load(module, {
      artifactRoot: join4(options.home, "artifacts", "pi", manifest.capability, manifest.provider),
      preview: (bytes, mime) => resizeImage(bytes, mime, { maxWidth: 1024, maxHeight: 1024, maxBytes: 512 * 1024 })
    });
    try {
      synchronize(ctx);
      if (manifest.modelInputExcludes?.length)
        report(
          ctx,
          `${id}: registered only while the active model lacks ${manifest.modelInputExcludes.join("/")} input.`
        );
    } catch (error) {
      await registry.unload(id);
      throw error;
    }
  };
  const load = async (id, ctx) => {
    const manifest = manager.find(id);
    const unsupported = manifest.requires?.filter((r) => !support.has(r));
    if (unsupported?.length) throw new Error(`Host lacks: ${unsupported.join(", ")}`);
    const module = await manager.load(id);
    operations.signal.throwIfAborted();
    if (registry.get(id)) return;
    await activate(module, ctx);
  };
  const saveConfig = (update) => {
    config = store.update(update);
    subagents.setDefaultModel(config.subagentModel);
    for (const key of Object.keys(registry.defaults)) delete registry.defaults[key];
    Object.assign(registry.defaults, config.defaults);
  };
  registerManagement(pi, {
    manager,
    registry,
    config: () => config,
    save: saveConfig,
    load,
    restore: activate,
    refresh,
    report,
    signal: () => operations.signal,
    subagents
  });
  pi.on("session_start", async (_event, ctx) => {
    disposed = false;
    if (operations.signal.aborted) operations = new AbortController();
    previousProvider = ctx.model?.provider;
    config = store.load();
    subagents.setEnabled(config.subagents === true);
    subagents.setDefaultModel(config.subagentModel);
    subagents.startSession(ctx.sessionManager.getSessionId());
    Object.assign(registry.defaults, config.defaults);
    for (const id of config.autoload) {
      try {
        await load(id, ctx);
      } catch (error) {
        report(ctx, `${id}: ${error.message}`, true);
      }
    }
    statusLine(ctx);
    installEnhanceFooter(ctx, command, () => footerLabels);
  });
  pi.on("model_select", async (event, ctx) => {
    const currentModel = event.model ?? ctx.model;
    const current = currentModel?.provider;
    if (previousProvider !== void 0 && current !== previousProvider)
      await registry.lifecycle("provider_change");
    previousProvider = current;
    statusLine({ ...ctx, model: currentModel });
    synchronize({ ...ctx, model: currentModel });
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
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.pi_enhance_release = releaseGuidance;
    const notices = registry.list().flatMap((e) => e.instance.notice?.() ?? []);
    if (notices.length)
      return { message: { customType: "pi-enhance:recovery", content: notices.join("\n"), display: false } };
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await registry.lifecycle("task_settled", () => ctx.isIdle());
  });
  pi.on("session_tree", async () => {
    subagents.cancelAll();
    await registry.lifecycle("session_tree");
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    subagents.shutdown();
    operations.abort();
    try {
      await registry.dispose();
    } finally {
      if (ctx.hasUI) {
        ctx.ui.setStatus(command, void 0);
        ctx.ui.setFooter(void 0);
      }
    }
  });
}
function piEnhance(pi) {
  const here = dirname2(fileURLToPath(import.meta.url));
  const dist = existsSync2(join4(here, "catalog.json")) ? here : join4(here, "../../../../dist");
  const catalog = JSON.parse(readFileSync2(join4(dist, "catalog.json"), "utf8"));
  createPiEnhance(pi, { home: enhanceHome(), catalog, moduleDirectory: join4(dist, "modules") });
}
export {
  createPiEnhance,
  piEnhance as default,
  executionContext,
  modelInfo
};
